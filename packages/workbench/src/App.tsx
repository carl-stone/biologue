import { useEffect, useRef, useState } from "react";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import { themeLight, type SerializedDockview } from "dockview";
import {
  Check,
  CircleHelp,
  FlaskConical,
  FolderOpen,
  LayoutTemplate,
  Maximize2,
  Minimize2,
  PanelsTopLeft,
  ShieldCheck,
  WifiOff,
  X,
} from "lucide-react";
import { api, useWorkbench, useSnapshot, type PanelId } from "./state.tsx";
import { Dialog, Spinner, modifier } from "./ui.tsx";
import { Chat } from "./panels/Chat.tsx";
import { Editor } from "./panels/Editor.tsx";
import { Console } from "./panels/Console.tsx";
import { Controls } from "./panels/Controls.tsx";
import { ResearchContext } from "./panels/ResearchContext.tsx";
import { Data, Environment, Plots } from "./panels/Results.tsx";

const components = {
  chat: Chat,
  editor: Editor,
  console: Console,
  plots: Plots,
  environment: Environment,
  context: ResearchContext,
  controls: Controls,
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
  { id: "controls", title: "Agent", label: "Agent" },
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
    add("controls", "environment", "within", true);
    add("console", "editor", "below");
    add("plots", "environment", "below");
    add("data", "plots", "within", true);
    layout.getPanel("chat")!.api.setSize({ width: 360 });
    layout.getPanel("environment")!.api.setSize({ width: 340 });
    layout
      .getPanel("console")!
      .api.setSize({ height: Math.max(240, Math.round(window.innerHeight * 0.31)) });
    layout.getPanel("plots")!.api.setSize({ height: Math.round(window.innerHeight * 0.4) });
  } else {
    if (mode === "compact") {
      add("chat");
      add("context", "chat", "within", true);
      add("controls", "chat", "within", true);
      add("editor", "chat", "right");
    } else {
      add("editor");
      add("chat", "editor", "within", true);
      add("context", "editor", "within", true);
      add("controls", "editor", "within", true);
    }
    add("console", "editor", mode === "narrow" ? "within" : "below", mode === "narrow");
    add("environment", "console", "within", true);
    add("plots", "console", "within", true);
    add("data", "console", "within", true);
    if (mode === "compact") layout.getPanel("chat")!.api.setSize({ width: 300 });
    if (mode === "compact")
      layout
        .getPanel("console")!
        .api.setSize({ height: Math.max(230, Math.round(window.innerHeight * 0.38)) });
  }
  layout.getPanel("editor")!.api.setActive();
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
  );
  const snapshot = useSnapshot("permissions", "layout", "executions", "project");
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
  const [layoutMode, setLayoutMode] = useState(mode.current);
  const reviewCount = wb.snapshot?.permissions.length || 0;
  function updateHeader(group: WorkspaceApi["groups"][number]) {
    const hidden = !arranging.current || mode.current === "narrow";
    if (group.header.hidden === hidden) return;
    group.header.hidden = hidden;
    group.relayout();
  }
  function arrangePanels(enabled: boolean) {
    arranging.current = enabled;
    setIsArranging(enabled);
    if (enabled) layout.current?.exitMaximizedGroup();
    layout.current?.groups.forEach(updateHeader);
  }
  function reveal(id: PanelId, maximize = false) {
    const target = layout.current?.getPanel(id);
    if (!target) return;
    if (layout.current!.hasMaximizedGroup()) layout.current!.exitMaximizedGroup();
    target.api.setActive();
    if (maximize) target.api.maximize();
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
      if (document.querySelector("dialog[open]")) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-8]$/.test(event.key)) {
        event.preventDefault();
        reveal(panels[Number(event.key) - 1].id);
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
    savedLayouts.current =
      (persisted?.version === 2 || persisted?.version === 3) && persisted.layouts
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
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed) return;
          savedLayouts.current[mode.current] = view.toJSON();
          void api("/layout", "PUT", { version: 3, layouts: savedLayouts.current }).catch(() => {});
        }, 500);
      }),
    ];
    const resize = () => {
      const next = windowMode();
      if (next === mode.current) return;
      clearTimeout(timer);
      view.exitMaximizedGroup();
      savedLayouts.current[mode.current] = view.toJSON();
      // Window resize fires before Dockview's ResizeObserver. Size the grid first
      // so pixel widths in the new layout are not scaled from the old viewport.
      const element = document.querySelector<HTMLElement>(".workspace > .dock-layout");
      if (element) view.layout(element.clientWidth, element.clientHeight);
      restore(next);
    };
    window.addEventListener("resize", resize);
    cleanup.current = () => {
      disposed = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      window.removeEventListener("resize", resize);
    };
  }
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
        <div className="project-name" title={wb.snapshot?.project}>
          <FolderOpen size={14} aria-hidden="true" />
          <span>{wb.snapshot?.project.split("/").pop() || "Opening workspace"}</span>
        </div>
        <div className="header-actions">
          <span className="connection-state">
            <span className={`status-dot ${wb.connected ? "online" : ""}`} />
            {wb.connected ? "Workspace connected" : "Reconnecting"}
          </span>
          {reviewCount > 0 && (
            <button className="review-badge" onClick={() => reveal("controls")}>
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
          <span>
            Connection lost. Reconnecting… You can keep editing; runs and saves will be available
            when connected.
          </span>
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
              <FlaskConical size={34} strokeWidth={1.3} />
              <h1>Opening your workspace</h1>
              <p>
                <Spinner />
                Connecting to the application server…
              </p>
              <span className="small-note">
                If this takes a moment, check that Biologue is running.
              </span>
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
              aria-label={`Open ${panel.title}`}
              aria-pressed={active === panel.id}
              title={`${panel.title} (Alt+${index + 1})`}
              disabled={!wb.snapshot}
              onClick={() => reveal(panel.id)}
            >
              {panel.label}
              {panel.id === "controls" && reviewCount > 0 && (
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
      {help && (
        <Dialog title="Make yourself at home" onClose={() => setHelp(false)}>
          <p>
            Choose Arrange in the bottom bar to reveal tabs, then drag them to move or group panels.
            Choose Done arranging or press Escape to hide the tabs. The layout remembers your
            arrangement at each window size.
          </p>
          <div className="help-section">
            <h3>Keep your work in view</h3>
            <p>
              Use the bottom navigation to open any panel. Expand panel gives it the full workspace;
              Escape brings the workspace back.
            </p>
          </div>
          <div className="help-section">
            <h3>Keyboard shortcuts</h3>
            <dl className="shortcut-list">
              <dt>Run the entire script / console input</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Save file / research context</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>S</kbd>
              </dd>
              <dt>Send a message or context</dt>
              <dd>
                <kbd>{modifier}</kbd> <kbd>Enter</kbd>
              </dd>
              <dt>Open a panel in navigation order</dt>
              <dd>
                <kbd>Alt</kbd> <kbd>1–8</kbd>
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
          <div className="help-section">
            <h3>Edit, run, save</h3>
            <p>
              Edits sync automatically with Biologue and are retained on this device while offline.
              <strong> Save</strong> writes the working document to your project file.
              <strong> Run file</strong> waits for synchronization and records the exact revision.
            </p>
          </div>
          <div className="dialog-actions">
            <button className="primary" onClick={() => setHelp(false)}>
              Back to the workspace
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
