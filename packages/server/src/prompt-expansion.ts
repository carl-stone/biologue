import type { PromptTemplate } from "@earendil-works/pi-coding-agent";

/** Expand the browser's prompt commands without importing an SDK private module. */
export function expandPrompt(text: string, templates: PromptTemplate[]) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match && templates.find((t) => t.name === match[1]);
  if (!template) return text;
  const args: string[] = [];
  let word = "",
    quote = "";
  for (const char of match![2] ?? "") {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (word) args.push(word);
      word = "";
    } else word += char;
  }
  if (word) args.push(word);
  return template.content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, target, fallback, start, length, simple) => {
      if (target)
        return (
          (target === "@" || target === "ARGUMENTS" ? args.join(" ") : args[Number(target) - 1]) ||
          fallback
        );
      if (start) {
        const offset = Math.max(0, Number(start) - 1);
        return args.slice(offset, length ? offset + Number(length) : undefined).join(" ");
      }
      return simple === "ARGUMENTS" || simple === "@"
        ? args.join(" ")
        : (args[Number(simple) - 1] ?? "");
    },
  );
}
