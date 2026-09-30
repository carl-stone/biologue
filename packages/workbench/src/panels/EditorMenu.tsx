import { useEffect, useRef } from "react";

export type EditorCommand = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  run: () => void;
};

export function EditorMenu({
  label,
  commands,
}: {
  label: string;
  commands: (EditorCommand | null)[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && ref.current) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      className="editor-menu"
      ref={ref}
      onKeyDown={(event) => {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          ref.current!.open = false;
          ref.current?.querySelector("summary")?.focus();
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          ref.current!.open = true;
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : index < 0
                  ? event.key === "ArrowUp"
                    ? items.length - 1
                    : 0
                  : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <summary aria-label={`${label} menu`}>{label}</summary>
      <div role="menu" aria-label={label}>
        {commands.map((command, i) =>
          command ? (
            <button
              key={command.label}
              role={command.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={command.checked}
              disabled={command.disabled}
              onClick={() => {
                ref.current!.open = false;
                command.run();
              }}
            >
              <span className="menu-check" aria-hidden="true">
                {command.checked ? "✓" : ""}
              </span>
              <span>{command.label}</span>
              <kbd>{command.shortcut}</kbd>
            </button>
          ) : (
            <hr key={i} />
          ),
        )}
      </div>
    </details>
  );
}
