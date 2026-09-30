import { useEffect, useRef, useState } from "react";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { themeLight, type SerializedDockview } from "dockview";
import {
  Check,
  CircleHelp,
  FolderOpen,
  LayoutTemplate,
  Maximize2,
  Minimize2,
  PanelsTopLeft,
  ShieldCheck,
  WifiOff,
  X,
  Search,
} from "lucide-react";
import {
  api,
  useWorkbench,
  useSnapshot,
  useResource,
  useOutputVersion,
  type PanelId,
} from "./state.tsx";
import type { DisplayOutput, Page } from "@carl/protocol";
import { Dialog, Spinner, modifier } from "./ui.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Chat } from "./panels/Chat.tsx";
import { Editor } from "./panels/Editor.tsx";
import { Console } from "./panels/Console.tsx";
import { ResearchContext } from "./panels/ResearchContext.tsx";
import { Data, Environment, Plots } from "./panels/Results.tsx";

const components = {
  chat: Chat,
  controls: () => null, // Read old saved layouts, then migrate this panel into conversation settings.
  editor: Editor,
  console: Console,
  plots: Plots,
  environment: Environment,
  context: ResearchContext,
  data: Data,
};
const workspaceTheme = { ...themeLight, gap: 1 };
const panels = [
  { id: "chat", title: "Conversation", label: "Conversation" },
  { id: "editor", title: "Editor", label: "Editor" },
  { id: "console", title: "Console", label: "Console" },
  { id: "environment", title: "Environment", label: "Environment" },
  { id: "plots", title: "Plots", label: "Plots" },
  { id: "data", title: "Data", label: "Data" },
  { id: "context", title: "Research context", label: "Research" },
] as const;
type LayoutMode = "wide" | "compact" | "narrow";
type Layouts = Partial<Record<LayoutMode, SerializedDockview>>;
type WorkspaceApi = DockviewReadyEvent["api"];
const windowMode = (): LayoutMode =>
  window.innerWidth < 900 ? "narrow" : window.innerWidth < 1220 ? "compact" : "wide";

function defaultLayout(layout: WorkspaceApi, mode: LayoutMode) {
  layout.clear();
  const add = (
    id: PanelId,
    reference?: PanelId,
    direction: "right" | "below" | "within" = "within",
    inactive = false,
  ) =>
    layout.addPanel({
      id,
      component: id,
      title: panels.find((panel) => panel.id === id)!.title,
      ...(reference ? { position: { referencePanel: reference, direction }, inactive } : {}),
    });
  if (mode === "wide") {
    add("chat");
    add("editor", "chat", "right");
    add("environment", "editor", "right");
    add("context", "environment", "within", true);
    add("console", "editor", "below");
    add("plots", "environment", "within", true);
    add("data", "plots", "within", true);
    layout.getPanel("chat")!.api.setSize({
      width: Math.min(620, Math.round((window.innerWidth - 340) * 0.45)),
    });
    layout.getPanel("environment")!.api.setSize({ width: 340 });
    layout
      .getPanel("console")!
      .api.setSize({ height: Math.max(240, Math.round(window.innerHeight * 0.31)) });
  } else {
    if (mode === "compact") {
      add("chat");
      add("context", "chat", "within", true);
      add("editor", "chat", "right");
    } else {
      add("editor");
      add("chat", "editor", "within", true);
      add("context", "editor", "within", true);
    }
    add("console", "editor", mode === "narrow" ? "within" : "below", mode === "narrow");
    add("environment", "console", "within", true);
    add("plots", "console", "within", true);
    add("data", "console", "within", true);
    if (mode === "compact")
      layout.getPanel("chat")!.api.setSize({ width: Math.round(window.innerWidth * 0.36) });
    if (mode === "compact")
      layout
        .getPanel("console")!
        .api.setSize({ height: Math.max(230, Math.round(window.innerHeight * 0.38)) });
  }
  layout.getPanel("chat")!.api.setActive();
}

export function App() {
  const state = useWorkbench(
    "connected",
    "error",
    "language",
    "notice",
    "notify",
    "panelRequest",
    "setError",
    "setLanguage",
    "ready",
    "revealPermission",
    "conversation",
  );
  const snapshot = useSnapshot("permissions", "runs", "layout", "executions", "project");
  const wb = { ...state, snapshot: state.ready ? snapshot : null };
  const layout = useRef<WorkspaceApi | null>(null);
  const savedLayouts = useRef<Layouts>({});
  const mode = useRef<LayoutMode>(windowMode());
  const arranging = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  const [active, setActive] = useState<PanelId>("editor");
  const [maximized, setMaximized] = useState(false);
  const [isArranging, setIsArranging] = useState(false);
  const [help, setHelp] = useState(false);
  const [projects, setProjects] = useState(false);
  const [commands, setCommands] = useState(false);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        setCommands((value) => !value);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);
  const [layoutMode, setLayoutMode] = useState(mode.current);
  const plotVersion = useOutputVersion(wb.language);
  const plotPage = useResource<Page<DisplayOutput>>(
    wb.ready ? `/outputs?language=${wb.language}&kind=plots&limit=1` : null,
    plotVersion,
  );
  useEffect(() => {
    if (!wb.ready || !wb.connected) return;
    void api("/environment", "POST", { language: wb.language }).catch((error) =>
      wb.setError(error.message),
    );
  }, [wb.ready, wb.connected, wb.language]);
  const revealedPlots = useRef(new Set<string>());
  const migrateEmptyPlots = useRef(true);
  const [layoutReady, setLayoutReady] = useState(0);
  const reviewRequests = (wb.snapshot?.permissions ?? []).filter(
    (request) =>
      active !== "chat" ||
      (request.conversationId ??
        snapshot.runs.find((run) => run.id === request.runId)?.conversationId) !==
        state.conversation,
  );
  const reviewCount = reviewRequests.length;
  function updateHeader(group: WorkspaceApi["groups"][number]) {
    const hidden = mode.current === "narrow" || (!arranging.current && group.panels.length === 1);
    const height = group.panels.length === 1 ? "14px" : "32px";
    if (
      group.header.hidden === hidden &&
      group.element.style.getPropertyValue("--dv-tabs-and-actions-container-height") === height
    )
      return;
    group.element.style.setProperty("--dv-tabs-and-actions-container-height", height);
    group.header.hidden = hidden;
    group.relayout();
  }
  function arrangePanels(enabled: boolean) {
    if (!enabled && document.activeElement?.closest(".dv-tabs-and-actions-container"))
      document
        .querySelector<HTMLElement>(
          mode.current === "narrow" ? ".nav-button.active" : ".arrange-panels",
        )
        ?.focus();
    arranging.current = enabled;
    setIsArranging(enabled);
    if (enabled) layout.current?.exitMaximizedGroup();
    layout.current?.groups.forEach(updateHeader);
  }
  function reveal(id: PanelId, maximize = false) {
    const target = layout.current?.getPanel(id === "controls" ? "chat" : id);
    if (!target) return;
    if (layout.current!.hasMaximizedGroup()) layout.current!.exitMaximizedGroup();
    target.api.setActive();
    if (maximize) target.api.maximize();
  }
  function focusPanel(id: PanelId) {
    requestAnimationFrame(() => {
      const destinations: Record<PanelId, string> = {
        chat: '.chat textarea[aria-label="Message Biologue"]',
        editor: ".editor-pane .cm-content",
        console: ".console-input textarea",
        context: "#research-notes",
        environment: ".environment",
        plots: ".plots",
        data: ".data-pane",
        controls: ".controls",
      };
      const content = document.querySelector<HTMLElement>(destinations[id]);
      const destination =
        (content?.matches(".pane") ? content.closest<HTMLElement>('[role="tabpanel"]') : content) ??
        document.querySelector<HTMLElement>(`button[data-panel="${id}"]`);
      if (destination?.getAttribute("role") === "tabpanel") destination.tabIndex = -1;
      destination?.focus({ preventScroll: true });
    });
  }
  function toggleFocus() {
    if (!layout.current) return;
    if (layout.current.hasMaximizedGroup()) layout.current.exitMaximizedGroup();
    else layout.current.activePanel?.api.maximize();
  }
  useEffect(() => {
    if (wb.panelRequest) reveal(wb.panelRequest.id, wb.panelRequest.maximize);
  }, [wb.panelRequest]);
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        const panel = panels[Number(event.key) - 1];
        reveal(panel.id);
        focusPanel(panel.id);
      } else if (event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleFocus();
      } else if (event.key === "Escape") {
        if (arranging.current) arrangePanels(false);
        else if (layout.current?.hasMaximizedGroup()) layout.current.exitMaximizedGroup();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  function ready(event: DockviewReadyEvent) {
    cleanup.current();
    const view = event.api;
    layout.current = view;
    const persisted = wb.snapshot?.layout as
      { version?: number; layouts?: Layouts; grid?: unknown } | undefined;
    migrateEmptyPlots.current = persisted?.version !== 4;
    savedLayouts.current =
      (persisted?.version === 2 || persisted?.version === 3 || persisted?.version === 4) &&
      persisted.layouts
        ? persisted.layouts
        : persisted?.grid
          ? { wide: persisted as SerializedDockview }
          : {};
    // Older narrow layouts split a small window into two cramped groups.
    if (persisted?.version === 2) delete savedLayouts.current.narrow;
    let restoring = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    function restore(next: LayoutMode) {
      restoring = true;
      mode.current = next;
      setLayoutMode(next);
      if (next === "narrow") arrangePanels(false);
      view.exitMaximizedGroup();
      try {
        const saved = savedLayouts.current[next];
        if (saved) {
          view.fromJSON(saved);
          const legacyControls = view.getPanel("controls");
          if (legacyControls) view.removePanel(legacyControls);
          if (panels.some((panel) => !view.getPanel(panel.id)))
            throw new Error("Incomplete layout");
        } else defaultLayout(view, next);
      } catch {
        defaultLayout(view, next);
      }
      // Header visibility is temporary; a saved arrangement can contain either state.
      view.groups.forEach(updateHeader);
      setMaximized(view.hasMaximizedGroup());
      setActive((view.activePanel?.id || "editor") as PanelId);
      restoring = false;
      setLayoutReady((value) => value + 1);
    }
    restore(windowMode());
    const subscriptions = [
      view.onDidAddGroup(updateHeader),
      view.onDidActivePanelChange((event) => {
        if (event.panel) setActive(event.panel.id as PanelId);
      }),
      view.onDidMaximizedGroupChange(() => setMaximized(view.hasMaximizedGroup())),
      view.onDidLayoutChange(() => {
        if (restoring) return;
        view.groups.forEach(updateHeader);
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed) return;
          savedLayouts.current[mode.current] = view.toJSON();
          void api("/layout", "PUT", { version: 4, layouts: savedLayouts.current }).catch(() => {});
        }, 500);
      }),
    ];
    const resize = () => {
      // Rebuilding groups unmounts panels. Finish a modal interaction before
      // changing layout mode so resizing cannot discard its input or request.
      if (document.querySelector("dialog[open]")) return;
      const next = windowMode();
      if (next === mode.current) return;
      clearTimeout(timer);
      const activePanel = view.activePanel?.id;
      view.exitMaximizedGroup();
      savedLayouts.current[mode.current] = view.toJSON();
      // Window resize fires before Dockview's ResizeObserver. Size the grid first
      // so pixel widths in the new layout are not scaled from the old viewport.
      const element = document.querySelector<HTMLElement>(".workspace > .dock-layout");
      if (element) view.layout(element.clientWidth, element.clientHeight);
      restore(next);
      if (activePanel) view.getPanel(activePanel)?.api.setActive();
    };
    window.addEventListener("resize", resize);
    cleanup.current = () => {
      disposed = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      window.removeEventListener("resize", resize);
    };
  }
  useEffect(() => {
    const view = layout.current;
    if (!view || !plotPage.data) return;
    const plots = view.getPanel("plots"),
      environment = view.getPanel("environment");
    if (!plots || !environment) return;
    if (!plotPage.data.items.length) {
      // Retire the old, permanently empty results split when restoring an older layout.
      if (
        migrateEmptyPlots.current &&
        mode.current === "wide" &&
        plots.group !== environment.group &&
        plots.group.panels.every((panel) => ["plots", "data"].includes(panel.id))
      ) {
        const focused = view.activePanel;
        const previousRightPanel = environment.group.activePanel;
        view.getPanel("data")?.api.moveTo({ group: environment.group, skipSetActive: true });
        plots.api.moveTo({ group: environment.group, skipSetActive: true });
        previousRightPanel?.api.setActive();
        focused?.api.setActive();
      }
      if (mode.current === "wide") migrateEmptyPlots.current = false;
      return;
    }
    if (mode.current !== "wide" || revealedPlots.current.has(wb.language)) return;
    revealedPlots.current.add(wb.language);
    if (mode.current === "wide") {
      if (plots.group === environment.group) {
        plots.api.moveTo({ group: environment.group, position: "bottom", skipSetActive: true });
        plots.api.setSize({ height: Math.round(window.innerHeight * 0.4) });
      }
      // Moving into a new group reveals the figure without moving typing focus.
    }
  }, [plotPage.data, layoutReady, wb.language]);
  const pending =
    wb.snapshot?.executions.filter(
      (item) => item.language === wb.language && ["queued", "running"].includes(item.status),
    ).length || 0;
  return (
    <div className="app">
      <a className="skip-link" href="#workspace-navigation">
        Skip to workspace navigation
      </a>
      <header className="app-header">
        <div className="brand">biologue</div>
        <button
          className="project-name text-button"
          title={wb.snapshot?.project}
          aria-label="Open project folder"
          onClick={() => setProjects(true)}
        >
          <FolderOpen size={14} aria-hidden="true" />
          <span>{wb.snapshot?.project.split("/").pop() || "Opening workspace"}</span>
        </button>
        <div className="header-actions">
          <button
            className="text-button"
            title="Commands (Ctrl/Cmd+K)"
            aria-label="Open commands"
            onClick={() => setCommands(true)}
          >
            <Search size={14} />
            Commands
          </button>
          {reviewCount > 0 && (
            <button className="review-badge" onClick={() => wb.revealPermission(reviewRequests[0])}>
              <ShieldCheck size={14} />
              {reviewCount} {reviewCount === 1 ? "request" : "requests"} awaiting review
            </button>
          )}
          <button
            className="text-button"
            aria-label="Workspace help"
            title="Workspace help & keyboard shortcuts"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={15} /> Help
          </button>
        </div>
      </header>
      {wb.error && (
        <div className="error-banner" role="alert">
          <span>{wb.error}</span>
          <button className="icon" aria-label="Dismiss error" onClick={() => wb.setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {!wb.connected && wb.snapshot && (
        <div className="connection-banner" role="status">
          <WifiOff size={16} />
          <span>Reconnecting… Edits are saved on this device.</span>
        </div>
      )}
      <div className="workbench-body">
        <main
          className={`workspace layout-${layoutMode}`}
          data-expanded={maximized}
          data-arranging={isArranging}
          aria-label="Scientific workspace"
        >
          {wb.snapshot ? (
            <div className="dock-layout">
              <DockviewReact
                components={components}
                onReady={ready}
                theme={workspaceTheme}
                disableFloatingGroups
                getTabContextMenuItems={() => ["maximize"]}
              />
            </div>
          ) : (
            <div className="workspace-loading">
              <Spinner /> Opening workspace…
            </div>
          )}
        </main>
      </div>
      <footer className="status-bar">
        <nav
          id="workspace-navigation"
          className="workspace-nav"
          aria-label="Workspace panels"
          tabIndex={-1}
        >
          {panels.map((panel, index) => (
            <button
              key={panel.id}
              className={`nav-button ${active === panel.id ? "active" : ""}`}
              aria-label={`Focus ${panel.title}`}
              data-panel={panel.id}
              aria-pressed={active === panel.id}
              title={`Show and focus ${panel.title} (Alt+${index + 1})`}
              disabled={!wb.snapshot}
              onClick={() => {
                reveal(panel.id);
                focusPanel(panel.id);
              }}
            >
              {panel.label}
              {panel.id === "chat" && reviewCount > 0 && (
                <span className="nav-count">{reviewCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="workspace-utilities">
          <div
            className="session-selector"
            title={
              pending ? `${pending} active or queued executions` : "Shared human and agent session"
            }
          >
            <span className={`status-dot ${pending ? "waiting" : wb.connected ? "online" : ""}`} />
            <select
              aria-label="Session language"
              value={wb.language}
              onChange={(event) => wb.setLanguage(event.target.value as "python" | "r")}
            >
              <option value="python">Python session</option>
              <option value="r">R session</option>
            </select>
            {pending > 0 && <span className="session-activity">{pending} active / queued</span>}
          </div>
          <button
            className="text-button panel-focus"
            aria-label={maximized ? "Restore layout" : "Expand panel"}
            title={maximized ? "Restore layout (Esc)" : "Expand panel (Alt+F)"}
            disabled={!wb.snapshot}
            onClick={toggleFocus}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span>{maximized ? "Restore layout" : "Expand panel"}</span>
          </button>
          <button
            className="text-button arrange-panels"
            aria-label={isArranging ? "Done arranging panels" : "Arrange panels"}
            aria-pressed={isArranging}
            title={isArranging ? "Finish arranging (Esc)" : "Show tabs to drag and regroup panels"}
            disabled={!wb.snapshot}
            onClick={() => arrangePanels(!arranging.current)}
          >
            {isArranging ? <Check size={14} /> : <PanelsTopLeft size={14} />}
            <span>{isArranging ? "Done arranging" : "Arrange"}</span>
          </button>
          <button
            className="icon"
            aria-label="Reset panel layout"
            title="Reset layout for this window size"
            disabled={!wb.snapshot}
            onClick={() => {
              if (layout.current) {
                revealedPlots.current.clear();
                setLayoutReady((value) => value + 1);
                defaultLayout(layout.current, mode.current);
                layout.current.groups.forEach(updateHeader);
                wb.notify("Panel layout reset. Your work is retained.");
              }
            }}
          >
            <LayoutTemplate size={15} />
          </button>
        </div>
      </footer>
      <div className={`toast ${wb.notice ? "visible" : ""}`} role="status" aria-live="polite">
        {wb.notice && (
          <>
            <Check size={16} />
            <span>{wb.notice}</span>
            <button
              className="icon"
              aria-label="Dismiss notification"
              onClick={() => wb.notify("")}
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
      {projects && <ProjectPicker onClose={() => setProjects(false)} />}
      {commands && (
        <CommandPalette
          onClose={() => setCommands(false)}
          onProjects={() => setProjects(true)}
          onHelp={() => setHelp(true)}
        />
      )}
      {help && (
        <Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)}>
          <p>Arrange: drag panels to move or group them. Escape to finish.</p>
          <div className="help-section">
            <dl className="shortcut-list">
              <dt>Run selection / line</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Run line</dt>
              <dd>
                <kbd>Shift</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Run file</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Find / replace</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>F</kbd>
              </dd>
              <dt>Commands</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>K</kbd>
              </dd>
              <dt>Save</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>S</kbd>
              </dd>
              <dt>Send message / run console input</dt>
              <dd>
                <kbd>Enter</kbd>
              </dd>
              <dt>New line in message / console</dt>
              <dd>
                <kbd>Shift</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Focus panel</dt>
              <dd>
                <kbd>Alt</kbd> <kbd>1–7</kbd>
              </dd>
              <dt>Expand active panel</dt>
              <dd>
                <kbd>Alt</kbd> <kbd>F</kbd>
              </dd>
              <dt>Restore layout</dt>
              <dd>
                <kbd>Esc</kbd>
              </dd>
            </dl>
          </div>
          <div className="dialog-actions">
            <button className="primary" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
