import { createRequire } from "node:module";
import { Parser, Language as Grammar, type Node } from "web-tree-sitter";
import type { Language } from "@biologue/protocol";

/** Syntactic evidence, never a proof of purity or of a branch having executed. */
export interface CodeEffects {
  reads: string[];
  calls: string[];
  writes: string[];
  mutates: string[];
  aliases: [string, string][];
  opaque: boolean;
  unresolvedSyntax?: boolean;
  notes: string[];
}
const require = createRequire(import.meta.url);
let grammars: Promise<Record<Language, Grammar>> | undefined;
function loadGrammars() {
  return (grammars ??= (async () => {
    await Parser.init();
    const [python, r] = await Promise.all([
      Grammar.load(require.resolve("tree-sitter-python/tree-sitter-python.wasm")),
      Grammar.load(require.resolve("@davisvaughan/tree-sitter-r/tree-sitter-r.wasm")),
    ]);
    return { python, r };
  })());
}

// These common calls don't imply a write on their own. This is a heuristic:
// overridden functions and custom dispatch can still have side effects.
const ordinaryCalls: Record<Language, Set<string>> = {
  python: new Set(
    "print len range sum min max abs round sorted list tuple dict set int float str bool enumerate zip type isinstance".split(
      " ",
    ),
  ),
  r: new Set(
    "print cat length nrow ncol dim names class typeof str head tail c list matrix data.frame mean sum min max abs round rowMeans colMeans rowSums colSums seq seq_along seq_len rep is.na".split(
      " ",
    ),
  ),
};
export const emptyEffects = (): CodeEffects => ({
  reads: [],
  calls: [],
  writes: [],
  mutates: [],
  aliases: [],
  opaque: false,
  notes: [],
});

/** Parse only: no R/Python interpreter, shell, or evaluation of submitted code. */
export async function analyzeCode(language: Language, code: string): Promise<CodeEffects> {
  const result = emptyEffects();
  const reads = new Set<string>(),
    writes = new Set<string>(),
    mutates = new Set<string>();
  const uncertain = (message: string) => {
    result.opaque = true;
    if (result.notes.length < 8 && !result.notes.includes(message)) result.notes.push(message);
  };
  if (code.length > 200_000) {
    result.unresolvedSyntax = true;
    uncertain("Code exceeds the static analysis size limit; dependencies and effects are unknown.");
    return result;
  }
  let parser: Parser | undefined;
  let tree: ReturnType<Parser["parse"]> = null;
  try {
    const grammar = (await loadGrammars())[language];
    parser = new Parser();
    parser.setLanguage(grammar);
    tree = parser.parse(code);
    if (!tree) throw new Error("Parser did not return a syntax tree.");
    if (tree.rootNode.hasError) {
      result.unresolvedSyntax = true;
      uncertain("Some syntax could not be parsed; dependency analysis is incomplete.");
    }
    const field = (n: Node | null, name: string) => n?.childForFieldName(name) ?? null;
    const named = (n: Node | null) =>
      n?.namedChildren.filter((child): child is Node => child !== null) ?? [];
    const identifier = (n: Node) => n.text.replace(/^`|`$/g, "");
    const rootName = (n: Node | null): string | undefined => {
      if (!n) return;
      if (n.type === "identifier") return identifier(n);
      return rootName(
        field(n, "object") ?? field(n, "value") ?? field(n, "lhs") ?? field(n, "function"),
      );
    };
    const bind = (n: Node | null, bound: Set<string>, local = false) => {
      if (!n) return;
      if (n.type === "identifier") {
        const name = identifier(n);
        if (!local) writes.add(name);
        bound.add(name);
      } else if (["pattern_list", "tuple_pattern", "list_pattern"].includes(n.type)) {
        for (const child of named(n)) bind(child, bound, local);
      } else {
        // R replacement functions, e.g. names(A) <- ..., modify their first argument.
        const target =
          language === "r" && n.type === "call"
            ? field(named(field(n, "arguments"))[0] ?? null, "value")
            : n;
        const name = rootName(target);
        if (name) mutates.add(name);
        visit(n, bound);
      }
    };
    const visit = (n: Node | null, bound: Set<string>, depth = 0): void => {
      if (!n) return;
      if (depth > 150) {
        result.unresolvedSyntax = true;
        uncertain("Deeply nested code exceeds the analysis limit.");
        return;
      }
      const children = () => {
        for (const child of named(n)) visit(child, bound, depth + 1);
      };
      const t = n.type;
      if (["comment", "string", "concatenated_string"].includes(t)) {
        if (language === "python") {
          // Interpolated strings contain executable expressions, unlike literal text.
          for (const child of n.descendantsOfType("interpolation")) visit(child, bound, depth + 1);
        }
        return;
      }
      if (t === "identifier") {
        if (!bound.has(identifier(n))) reads.add(identifier(n));
        return;
      }
      if (t === "function_definition" || t === "lambda") {
        if (language === "python") {
          for (const parameter of named(field(n, "parameters"))) {
            visit(field(parameter, "value"), bound, depth + 1);
            visit(field(parameter, "type"), bound, depth + 1);
          }
          visit(field(n, "return_type"), bound, depth + 1);
          bind(field(n, "name"), bound);
        }
        // Function bodies (and R default arguments) are not run at definition time.
        return;
      }
      if (t === "class_definition") {
        uncertain("Class initialization may have unverified dependencies and side effects.");
        visit(field(n, "superclasses"), bound, depth + 1);
        bind(field(n, "name"), bound);
        return;
      }
      if (t === "attribute" || t === "extract_operator") {
        visit(field(n, language === "python" ? "object" : "lhs"), bound, depth + 1);
        return;
      }
      if (t === "namespace_operator") return; // pkg::fun is not a workspace binding
      if (t === "keyword_argument" || t === "argument") {
        visit(field(n, "value"), bound, depth + 1);
        return;
      }
      const operator = field(n, "operator")?.text ?? n.children.find((c) => c && !c.isNamed)?.text;
      const rAssignment =
        language === "r" &&
        t === "binary_operator" &&
        ["<-", "=", "<<-", "->", "->>"].includes(operator ?? "");
      if (["assignment", "augmented_assignment", "named_expression"].includes(t) || rAssignment) {
        const rightward = operator === "->" || operator === "->>";
        const lhs =
          field(n, language === "r" ? (rightward ? "rhs" : "lhs") : "left") ?? field(n, "name");
        const rhs =
          field(n, language === "r" ? (rightward ? "lhs" : "rhs") : "right") ?? field(n, "value");
        visit(rhs, bound, depth + 1);
        if (t === "augmented_assignment") {
          visit(lhs, bound, depth + 1);
          // Python += and friends may mutate an object shared through aliases
          // (notably lists and NumPy arrays), even when the target is a bare name.
          const name = rootName(lhs);
          if (name) mutates.add(name);
        }
        if (
          lhs?.type === "identifier" &&
          rhs &&
          [
            "identifier",
            "subscript",
            "subset",
            "subset2",
            "attribute",
            "extract_operator",
          ].includes(rhs.type)
        ) {
          const root = rootName(rhs);
          if (root) result.aliases.push([identifier(lhs), root]);
        }
        bind(lhs, bound);
        return;
      }
      if (t === "delete_statement") {
        for (const child of named(n)) {
          bind(child, bound);
          if (child.type === "identifier") bound.delete(identifier(child));
        }
        return;
      }
      if (t === "import_statement" || t === "import_from_statement") {
        for (const child of n.childrenForFieldName("name")) {
          if (!child) continue;
          const name = field(child, "alias")?.text ?? child.text.split(".")[0];
          writes.add(name);
          bound.add(name);
        }
        uncertain("Importing a module may run initialization code or alter runtime configuration.");
        return;
      }
      if (t.endsWith("comprehension") || t === "generator_expression") {
        const scope = new Set(bound);
        for (const child of named(n)) {
          if (child.type === "for_in_clause") {
            visit(field(child, "right"), scope, depth + 1);
            bind(field(child, "left"), scope, true);
          } else if (child.type === "if_clause") visit(child, scope, depth + 1);
        }
        visit(field(n, "body"), scope, depth + 1);
        return;
      }
      if (t === "for_statement") {
        visit(field(n, language === "r" ? "sequence" : "right"), bound, depth + 1);
        const scope = new Set(bound);
        bind(field(n, language === "r" ? "variable" : "left"), scope);
        visit(field(n, "body"), scope, depth + 1);
        visit(field(n, "alternative"), new Set(bound), depth + 1);
        return;
      }
      if (["if_statement", "while_statement", "try_statement", "match_statement"].includes(t)) {
        // A conditional assignment is not a guaranteed definition for later statements.
        for (const child of named(n)) visit(child, new Set(bound), depth + 1);
        return;
      }
      if (t === "call") {
        const fn = field(n, "function"),
          args = field(n, "arguments");
        const name = fn?.text ?? "unknown";
        // A.mean() reads the data object A; only a bare callable name is a
        // function reference rather than an observation of an input object.
        const called = fn?.type === "identifier" ? identifier(fn) : undefined;
        if (called && !result.calls.includes(called)) result.calls.push(called);
        if (language === "r" && ["rm", "remove"].includes(name)) {
          for (const arg of named(args)) {
            const value = field(arg, "value");
            if (value?.type === "identifier" && !field(arg, "name")) {
              writes.add(identifier(value));
              bound.delete(identifier(value));
            } else uncertain("Dynamic removal may delete workspace objects not identified here.");
          }
        } else if (!ordinaryCalls[language].has(name)) {
          uncertain(`Call to ${name.slice(0, 80)} has unverified dependencies and side effects.`);
          const receiver = fn && rootName(field(fn, "object") ?? field(fn, "lhs"));
          if (receiver) mutates.add(receiver);
          for (const arg of named(args)) {
            const root = rootName(
              arg.type === "argument" || arg.type === "keyword_argument"
                ? field(arg, "value")
                : arg,
            );
            if (root) mutates.add(root);
          }
        }
        visit(fn, bound, depth + 1);
        visit(args, bound, depth + 1);
        return;
      }
      if (language === "r" && t === "binary_operator" && [":=", "~", "|>"].includes(operator ?? ""))
        uncertain(
          "R reference assignment, formulas, or nonstandard evaluation may hide dependencies or effects.",
        );
      if (
        [
          "class_definition",
          "with_statement",
          "global_statement",
          "nonlocal_statement",
          "ERROR",
        ].includes(t)
      )
        uncertain(`The effects of ${t} are not fully resolved.`);
      children();
    };
    visit(tree.rootNode, new Set());
  } catch (error) {
    result.unresolvedSyntax = true;
    uncertain(
      `Static analysis unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    tree?.delete();
    parser?.delete();
  }
  result.reads = [...reads].sort();
  result.writes = [...writes].sort();
  result.mutates = [...mutates].sort();
  return result;
}
