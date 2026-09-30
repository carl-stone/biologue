import {
  compact,
  type ExtensionFactory,
  type AgentSession,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const scientificRetention = `Retain the scientific question, experimental design, sample relationships, negative results, and unresolved questions.
Keep measurements and sources, scientist reports, interpretations, assumptions, and decisions distinct, with their uncertainty and scope.
Preserve corrections, superseded claims, affected work, and wording that affects meaning.
Keep execution/artifact IDs, source versions, unresolved context warnings, and reasons for acknowledgment. Captured outputs describe past state.
Current project notes remain the scientist's account; summaries must not override them.`;

export interface ScienceIntegration {
  research: { text: string; version: number };
  settings?: { mode?: string };
  stream: AgentSession["agent"]["streamFunction"];
  retrySettings: ReturnType<SettingsManager["getRetrySettings"]>;
  attributeMessage: (message: AgentMessage) => AgentMessage;
  onContext: (messages: AgentMessage[]) => void;
  onError: (error: Error) => void;
}
export function createScientificExtension(input: ScienceIntegration): ExtensionFactory {
  const researchNotes = `Scientist's project notes (version ${input.research.version}):\n${input.research.text || "No notes."}`;
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.research_context = researchNotes;
      event.systemPromptOptions.sections.scientific_workspace =
        "You and the scientist share live R and Python sessions. Context checks infer changes from recorded code and may miss indirect or external changes.";
      event.systemPromptOptions.sections.permission_mode =
        input.settings?.mode === "plan"
          ? "Plan mode: read project files and inspect existing objects. Discuss and propose the work; do not edit files or execute analysis code."
          : `Permission mode: ${input.settings?.mode ?? "ask"}. Use the workspace tools for all execution and edits. Approval settings do not change scientific checks or validate interpretations.`;
    });
    pi.on("message_end", (event) => ({ message: input.attributeMessage(event.message) }));
    pi.on("context", (event) => {
      input.onContext(event.messages);
    });
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        if (!ctx.model) throw new Error("Cannot compact without a model.");
        const result = await compact(
          event.preparation,
          ctx.model,
          undefined,
          undefined,
          event.customInstructions,
          event.signal,
          "off",
          (model, context, options) =>
            input.stream(
              model,
              {
                ...context,
                // Supply the policy once, including Pi's split-turn summary,
                // which does not receive customInstructions.
                messages: context.messages.map((message) =>
                  message.role === "system"
                    ? {
                        ...message,
                        sections: {
                          ...message.sections,
                          scientific_retention: scientificRetention,
                          research_context: researchNotes,
                        },
                      }
                    : message,
                ),
              },
              options,
            ),
          undefined,
          input.retrySettings,
        );
        return {
          compaction: {
            ...result,
            details: {
              ...(result.details && typeof result.details === "object" ? result.details : {}),
              biologue: { researchContextVersion: input.research.version },
            },
          },
        };
      } catch (error) {
        // Pi logs extension exceptions and falls back. Do not silently fall back to
        // a generic summary after the scientific retention hook fails.
        if (!event.signal.aborted)
          input.onError(
            new Error(
              `Scientific context compaction failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        return { cancel: true };
      }
    });
    pi.on("session_before_tree", (event) => ({
      customInstructions: `${scientificRetention}\n${event.preparation.customInstructions ?? ""}`,
    }));
  };
}
