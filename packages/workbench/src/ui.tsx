import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useWorkbench, useSnapshot } from "./state.tsx";

export const languageName = (language: string) => (language === "r" ? "R" : "Python");
export const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
export const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div>{children}</div>
    </div>
  );
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}
export function Spinner() {
  return <LoaderCircle size={15} className="spin" aria-hidden="true" />;
}

/** A synchronous guard also prevents repeated keyboard submissions before React paints. */
export function useAction() {
  const { perform } = useWorkbench("perform");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const run = async (action: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await perform(action);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Project-scoped UI drafts survive tab moves, layout changes, and reloads. */
export function useProjectDraft<T>(name: string, initial: T) {
  const { setError } = useWorkbench("setError");
  const snapshot = useSnapshot("project");
  const key = `carl-${name}:${snapshot!.project}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      setError(
        "Local draft storage is unavailable. Keep this window open and save your work before leaving.",
      );
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** Follow new output only while the reader is already at the bottom. */
export function useFollowOutput(change: string | number, resetKey: string, hasContent = true) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  function toLatest() {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    follow.current = true;
    setAway(false);
  }
  useEffect(() => {
    if (hasContent) toLatest();
    else if (scroll.current) scroll.current.scrollTop = 0;
  }, [resetKey, hasContent]);
  useEffect(() => {
    if (hasContent && follow.current) toLatest();
  }, [change]);
  const onScroll = () => {
    const element = scroll.current;
    if (!element) return;
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    setAway(!follow.current);
  };
  return { scroll, onScroll, away, toLatest };
}

export function CopyButton({
  text,
  label = "Copy code",
}: {
  text: string | (() => string);
  label?: string;
}) {
  const { notify } = useWorkbench("notify");
  const action = useAction();
  return (
    <button
      className="icon"
      aria-label={label}
      title={label}
      disabled={action.busy}
      onClick={() =>
        void action.run(async () => {
          await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
          notify(`${label.replace(/^Copy /, "")} copied to clipboard`);
        })
      }
    >
      <Copy size={14} />
    </button>
  );
}

export function Dialog({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const field = dialog.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    );
    field?.focus();
    if (field instanceof HTMLInputElement && ["text", "search"].includes(field.type))
      field.select();
    return () => {
      dialog.close();
      returnFocus.current?.focus();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) {
          const bounds = ref.current.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function SavedLabel({ dirty, children }: { dirty: boolean; children: ReactNode }) {
  return (
    <span className={`save-state ${dirty ? "unsaved" : ""}`} role="status">
      {dirty ? <span className="dirty-dot" /> : <Check size={12} />}
      {children}
    </span>
  );
}

export function downloadText(text: string, filename: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
