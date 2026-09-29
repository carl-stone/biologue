import type { OutputService } from "./outputs.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRun, Execution } from "@carl/protocol";
import type { Documents } from "./documents.ts";
import type { ExecutionService } from "./execution.ts";
import type { Permissions } from "./permissions.ts";
import { adapters, decodeInspection } from "./adapters.ts";
import type { StaleContext } from "./stale-context.ts";
import { textResult, clip, executionText, inspectionResult, artifactText } from "./tool-results.ts";

const limit = 16_000;
function executionResult(record: Execution, outputs: OutputService, context: StaleContext) {
  if (record.status !== "succeeded" && record.status !== "not_executed")
    throw new Error(
      `Execution ${record.id} ${record.status}: ${clip(record.error ?? "No result.", 2000)}`,
    );
  const effects = record.status === "succeeded" ? context.effects(record.id) : undefined;
  return textResult(executionText(record, outputs), {
    executionId: record.id,
    ...(effects
      ? {
          biologueObservation: {
            executionId: record.id,
            names: [
              ...new Set([
                ...effects.reads.filter((name) => !effects.calls.includes(name)),
                ...effects.writes,
                ...effects.mutates,
              ]),
            ],
            kind: "execution_result" as const,
          },
        }
      : {}),
  });
}

export function workspaceTools(
  run: AgentRun,
  documents: Documents,
  execution: ExecutionService,
  permissions: Permissions,
  skills: Skill[],
): ToolDefinition[] {
  execution.context.begin(run.conversationId);
  const language = Type.Union([Type.Literal("python"), Type.Literal("r")]);
  const projectPath = (path: string) => relative(documents.root, resolve(documents.root, path));
  const skillsRoots = skills.map((skill) => realpathSync(skill.baseDir));
  const tools: ToolDefinition[] = [
    {
      name: "list_files",
      label: "List project files",
      description: "List project files.",
      parameters: Type.Object({
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "File index (0-based; default 0)." }),
        ),
      }),
      execute: async (_id, raw) => {
        const { offset } = z.object({ offset: z.number().int().min(0).default(0) }).parse(raw);
        const files = documents.list();
        const page: string[] = [];
        let remaining = 12_000;
        for (const file of files.slice(offset, offset + 200)) {
          if (file.length + 1 > remaining) break;
          page.push(file);
          remaining -= file.length + 1;
        }
        const next = offset + page.length;
        return textResult(
          (page.join("\n") || "No more files.") +
            (next < files.length ? `\n[More: list_files offset=${next}.]` : ""),
        );
      },
    },
    {
      name: "read",
      label: "Read current document or skill",
      description:
        "Read a text document's current buffer and version (including unsaved edits), or a discovered skill resource.",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(
          Type.Integer({ minimum: 1, description: "Starting line (1-based; default 1)." }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 2000, description: "Line count (default 200)." }),
        ),
        characterOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Character offset within the selected lines; use the continuation hint.",
          }),
        ),
      }),
      execute: async (_id, raw) => {
        const args = z
          .object({
            path: z.string().min(1),
            offset: z.number().int().min(1).default(1),
            limit: z.number().int().min(1).max(2000).default(200),
            characterOffset: z.number().int().min(0).default(0),
          })
          .parse(raw);
        let source: { path: string; version?: number; content: string };
        try {
          source = documents.open(projectPath(args.path));
        } catch (error) {
          const actual = realpathSync(resolve(documents.root, args.path));
          if (!skillsRoots.some((root) => actual === root || actual.startsWith(root + sep)))
            throw error;
          if (statSync(actual).size > 2_000_000)
            throw new Error("Skill resource exceeds the text-read limit.");
          source = { path: actual, content: readFileSync(actual, "utf8") };
        }
        if (source.content.includes("\0"))
          throw new Error("Binary file; inspect it with execute_code.");
        const lines = source.content.split("\n");
        const selected = lines.slice(args.offset - 1, args.offset - 1 + args.limit).join("\n");
        if (args.offset > lines.length) throw new Error(`File has ${lines.length} lines.`);
        if (args.characterOffset > selected.length)
          throw new Error("Character offset exceeds the selected range.");
        const content = selected.slice(args.characterOffset, args.characterOffset + limit);
        const nextCharacter = args.characterOffset + content.length;
        const continuation =
          nextCharacter < selected.length
            ? `offset=${args.offset}, limit=${args.limit}, characterOffset=${nextCharacter}`
            : args.offset - 1 + args.limit < lines.length
              ? `offset=${args.offset + args.limit}`
              : undefined;
        const heading =
          source.version === undefined ? "" : `${source.path} (version ${source.version})\n`;
        return textResult(
          `${heading}${content}${continuation ? `\n\n[More: read ${continuation}.]` : ""}`,
        );
      },
    },
    {
      name: "edit_document",
      label: "Edit document buffer",
      description:
        "Replace a document buffer; requires approval and does not save to disk. Read the whole document first.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        expectedVersion: Type.Integer({ minimum: 1, description: "Version returned by read." }),
      }),
      execute: async (toolCallId, raw, signal) => {
        const args = z
          .object({
            path: z.string().max(1000),
            content: z.string().max(2_000_000),
            expectedVersion: z.number().int().min(1),
          })
          .parse(raw);
        await permissions.request(
          {
            runId: run.id,
            toolCallId,
            tool: "edit_document",
            description: `Replace the buffer for ${args.path} at version ${args.expectedVersion}.`,
            code: args.content,
          },
          signal,
        );
        signal?.throwIfAborted();
        const doc = documents.edit(projectPath(args.path), args.content, args.expectedVersion);
        return textResult(`Updated ${doc.path} (version ${doc.version}).`);
      },
    },
    {
      name: "inspect_environment",
      label: "Inspect shared environment",
      description:
        "Preview live object names, types, and values with bounded recorded code. R promises may be evaluated.",
      parameters: Type.Object({
        language,
        names: Type.Optional(
          Type.Array(Type.String(), {
            maxItems: 100,
            description: "Select specific objects; omit to list the environment.",
          }),
        ),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "Object index (0-based; default 0)." }),
        ),
      }),
      execute: async (toolCallId, raw, signal) => {
        const args = z
          .object({
            language: z.enum(["python", "r"]),
            names: z.array(z.string().max(1000)).max(100).optional(),
            offset: z.number().int().min(0).default(0),
          })
          .parse(raw);
        signal?.throwIfAborted();
        const record = execution.submit({
          language: args.language,
          actor: "agent",
          purpose: "inspection",
          inspection: "environment",
          code: adapters[args.language].inspectionCode(args),
          inspectionOptions: { names: args.names, offset: args.offset },
          runId: run.id,
          conversationId: run.conversationId,
          toolCallId,
        });
        const finished = await execution.wait(record.id);
        if (finished.status !== "succeeded")
          return executionResult(finished, execution.outputs, execution.context);
        return inspectionResult(finished, execution.outputs, args.names, args.offset);
      },
    },
    {
      name: "execute_code",
      label: "Execute in shared session",
      description:
        "Run code in the shared session with approval. On 'Not run', inspect or revise, or acknowledge the warning with a reason.",
      parameters: Type.Object({
        language,
        code: Type.String(),
        reason: Type.String({ description: "Purpose for approval." }),
        document: Type.Optional(
          Type.Object(
            { path: Type.String(), version: Type.Integer({ minimum: 1 }) },
            {
              description:
                "Required for complete document buffers; use the current path and version.",
            },
          ),
        ),
        acknowledgment: Type.Optional(
          Type.Object(
            {
              warningExecutionId: Type.String(),
              reason: Type.String({
                minLength: 1,
                maxLength: 2000,
                description: "Why this code remains appropriate.",
              }),
            },
            {
              description: "Accept the warning for unchanged code; new changes are checked.",
            },
          ),
        ),
      }),
      execute: async (toolCallId, raw, signal) => {
        const args = z
          .object({
            language: z.enum(["python", "r"]),
            code: z.string().min(1).max(200_000),
            reason: z.string().max(5000),
            document: z.object({ path: z.string(), version: z.number().int().min(1) }).optional(),
            acknowledgment: z
              .object({
                warningExecutionId: z.string().uuid(),
                reason: z.string().trim().min(1).max(2000),
              })
              .optional(),
          })
          .parse(raw);
        if (args.document) {
          args.document.path = projectPath(args.document.path);
          documents.verifyReference(args.document.path, args.document.version, args.code);
        }
        await permissions.request(
          {
            runId: run.id,
            toolCallId,
            tool: "execute_code",
            description: args.reason,
            code: args.code,
            language: args.language,
          },
          signal,
        );
        signal?.throwIfAborted();
        const record = execution.submit({
          language: args.language,
          code: args.code,
          document: args.document,
          actor: "agent",
          runId: run.id,
          toolCallId,
          conversationId: run.conversationId,
          acknowledgment: args.acknowledgment,
          beforeDispatch: args.document
            ? () => {
                const { path, version } = args.document!;
                documents.verifyReference(path, version, args.code);
                if (documents.open(path).version !== version)
                  throw new Error(
                    "Document changed before execution. Re-read and review it before retrying.",
                  );
              }
            : undefined,
        });
        return executionResult(
          await execution.wait(record.id),
          execution.outputs,
          execution.context,
        );
      },
    },
    {
      name: "read_execution",
      label: "Read recorded execution",
      description:
        "Read recorded code and output previews. Use read_artifact for full output or images.",
      parameters: Type.Object({
        executionId: Type.String(),
        codeOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Code character offset (0-based). Nonzero pages code.",
          }),
        ),
        outputOffset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Output index (0-based). Nonzero pages outputs.",
          }),
        ),
      }),
      execute: async (_id, raw) => {
        const { executionId, codeOffset, outputOffset } = z
          .object({
            executionId: z.string().uuid(),
            codeOffset: z.number().int().min(0).default(0),
            outputOffset: z.number().int().min(0).default(0),
          })
          .parse(raw);
        const record = execution.get(executionId);
        if (!record) throw new Error("Execution does not exist.");
        return textResult(executionText(record, execution.outputs, { codeOffset, outputOffset }), {
          executionId: record.id,
        });
      },
    },
    {
      name: "read_artifact",
      label: "Inspect captured artifact",
      description:
        "Read captured text, data, or a PNG. Historical output does not establish current runtime state.",
      parameters: Type.Object({
        executionId: Type.String(),
        outputId: Type.String(),
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "Text character offset (0-based; default 0)." }),
        ),
      }),
      execute: async (_id, raw, _signal, _update, ctx) => {
        const args = z
          .object({
            executionId: z.string().uuid(),
            outputId: z.string().uuid(),
            offset: z.number().int().min(0).default(0),
          })
          .parse(raw);
        const output = execution.outputs.get(args.outputId);
        if (!output || output.executionId !== args.executionId)
          throw new Error("Artifact does not exist in that execution.");
        const record = execution.get(args.executionId)!;
        const image = output.data?.["image/png"];
        const text = artifactText(output, args.offset);
        // Only a complete environment artifact establishes observations. Partial
        // JSON may cut through a row; never credit unseen names from its full record.
        const observed =
          record.inspection === "environment" &&
          args.offset === 0 &&
          output.text !== undefined &&
          output.text.length <= 16_000
            ? decodeInspection("environment", [output])
            : undefined;
        const response = textResult(text || "No text output.", {
          executionId: record.id,
          ...(observed?.kind === "environment"
            ? {
                biologueObservation: {
                  executionId: record.id,
                  names: observed.rows
                    .filter((row) => row.observed !== false)
                    .map((row) => row.name),
                  kind: "environment_preview" as const,
                },
              }
            : {}),
        });
        if (typeof image === "string" && args.offset === 0 && ctx.model?.input.includes("image")) {
          if (image.length > 14_000_000)
            throw new Error(
              "Image exceeds the retrieval limit. Create a smaller view with execute_code.",
            );
          return {
            content: [
              ...(text ? response.content : []),
              { type: "image" as const, data: image, mimeType: "image/png" },
            ],
            details: response.details,
          };
        }
        if (typeof image === "string" && args.offset === 0)
          return textResult(
            `${text}${text ? "\n" : ""}[PNG omitted: this model does not accept images.]`,
            response.details,
          );
        return response;
      },
    },
  ];
  return tools.map((tool) => ({ ...tool, executionMode: "sequential" }));
}
