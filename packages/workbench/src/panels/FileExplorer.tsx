import { useState } from "react";
import { ChevronRight, Folder, X } from "lucide-react";

type Entry = { name: string; path: string; children?: Entry[] };
function tree(files: string[]): Entry[] {
  const roots: Entry[] = [];
  for (const path of [...files].sort()) {
    const parts = path.startsWith("untitled:") ? [path.split("/").at(-1)!] : path.split("/");
    let entries = roots;
    parts.forEach((name, index) => {
      if (index === parts.length - 1) entries.push({ name, path });
      else {
        const prefix = parts.slice(0, index + 1).join("/");
        let folder = entries.find((entry) => entry.path === prefix && entry.children);
        if (!folder) {
          folder = { name, path: prefix, children: [] };
          entries.push(folder);
        }
        entries = folder.children!;
      }
    });
  }
  return roots;
}
export function FileExplorer({
  files,
  selected,
  dirty,
  onOpen,
  onClose,
}: {
  files: string[];
  selected: string;
  dirty: (path: string) => boolean;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const entries = tree(files.filter((path) => path.toLowerCase().includes(filter.toLowerCase())));
  const render = (entries: Entry[], depth = 0) =>
    entries.map((entry) =>
      entry.children ? (
        <details key={entry.path} open className="explorer-folder">
          <summary style={{ paddingLeft: 8 + depth * 12 }}>
            <ChevronRight size={12} />
            <Folder size={13} />
            {entry.name}
          </summary>
          {render(entry.children, depth + 1)}
        </details>
      ) : (
        <button
          key={entry.path}
          className={selected === entry.path ? "selected" : ""}
          aria-current={selected === entry.path ? "page" : undefined}
          title={entry.path}
          style={{ paddingLeft: 22 + depth * 12 }}
          onClick={() => onOpen(entry.path)}
        >
          <span>{entry.name}</span>
          {dirty(entry.path) && <span className="unsaved-dot" aria-label="Unsaved changes" />}
        </button>
      ),
    );
  return (
    <aside className="file-explorer" aria-label="Project files">
      <div className="explorer-heading">
        <span>Files</span>
        <button className="icon" aria-label="Hide file explorer" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <input
        aria-label="Filter project files"
        placeholder="Filter files…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="explorer-tree">
        {render(entries)}
        {!entries.length && <p className="small-note">No matching files</p>}
      </div>
    </aside>
  );
}
