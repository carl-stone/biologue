import { useEffect, useState } from "react";
import type { Conversation } from "@carl/protocol";
import { api, useSnapshot, useWorkbench, type PanelId } from "./state.tsx";
import { Dialog, useAction } from "./ui.tsx";

export function CommandPalette({
  onClose,
  onProjects,
  onHelp,
}: {
  onClose: () => void;
  onProjects: () => void;
  onHelp: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    document.getElementById(`command-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  const { files, runs, conversations } = useSnapshot("files", "runs", "conversations");
  const { showPanel, setFile, conversation, setConversation } = useWorkbench(
    "showPanel",
    "setFile",
    "conversation",
    "setConversation",
  );
  const action = useAction();
  const editorCommand = (name: string) => {
    showPanel("editor");
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("biologue:editor-command", { detail: name })),
    );
  };
  const commands: { label: string; run: () => unknown }[] = [
    {
      label: "New conversation",
      run: async () => {
        const created = await api<Conversation>("/conversations", "POST", {});
        setConversation(created.id);
        showPanel("chat");
      },
    },
    ...Object.entries({
      open: "Open file…",
      new: "New file",
      saveAs: "Save file as…",
      saveAll: "Save all files",
      find: "Find / replace in file",
      goToLine: "Go to line…",
      explorer: "Toggle file explorer",
    }).map(([name, label]) => ({ label, run: () => editorCommand(name) })),
    { label: "Choose project folder", run: onProjects },
    { label: "Model, thinking and agent settings", run: () => showPanel("controls") },
    { label: "Keyboard shortcuts", run: onHelp },
    ...(
      [
        ["chat", "Conversation"],
        ["editor", "Editor"],
        ["console", "Console"],
        ["environment", "Environment"],
        ["data", "Data"],
        ["plots", "Plots"],
        ["context", "Research context"],
      ] as [PanelId, string][]
    ).map(([id, label]) => ({ label: `Show ${label}`, run: () => showPanel(id) })),
    ...(conversation &&
    !runs.some((run) => run.conversationId === conversation && run.status === "running")
      ? [
          {
            label: "Compact conversation context",
            run: () => api(`/conversations/${conversation}/compact`, "POST", {}),
          },
        ]
      : []),
    ...conversations
      .filter((item) => !item.archived)
      .map((item) => ({
        label: `Conversation: ${item.title}`,
        run: () => {
          setConversation(item.id);
          showPanel("chat");
        },
      })),
    ...files.map((path) => ({
      label: `Open ${path}`,
      run: () => {
        setFile(path);
        showPanel("editor");
      },
    })),
  ];
  const matches = commands
    .filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 100);
  const choose = (item: (typeof commands)[number]) =>
    void action.run(async () => {
      await item.run();
      onClose();
    });
  return (
    <Dialog title="Commands" onClose={onClose}>
      <input
        autoFocus
        role="combobox"
        aria-label="Find command or file"
        aria-expanded="true"
        aria-controls="command-results"
        aria-activedescendant={matches[index] ? `command-${index}` : undefined}
        placeholder="Find command, file or conversation…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((value) =>
              Math.max(0, Math.min(matches.length - 1, value + (e.key === "ArrowDown" ? 1 : -1))),
            );
          }
          if (e.key === "Enter" && matches[index]) {
            e.preventDefault();
            choose(matches[index]);
          }
        }}
      />
      <div id="command-results" className="command-results" role="listbox" aria-label="Commands">
        {!matches.length && <p className="small-note">No matching commands or files</p>}
        {matches.map((item, i) => (
          <button
            id={`command-${i}`}
            role="option"
            aria-selected={i === index}
            key={item.label}
            disabled={action.busy}
            onClick={() => choose(item)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
