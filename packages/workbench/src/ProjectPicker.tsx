import { useEffect, useState } from "react";
import { FolderOpen, ArrowUp } from "lucide-react";
import { origin, useWorkbench, useSnapshot } from "./state.tsx";
import { Dialog, useAction } from "./ui.tsx";

type Folders = {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  recent: string[];
};
async function projects<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api/projects${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Carl-Client": "workbench" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Could not open folder.");
  return value;
}
export function ProjectPicker({ onClose }: { onClose: () => void }) {
  const { project } = useSnapshot("project");
  const { syncDocuments } = useWorkbench("syncDocuments");
  const [path, setPath] = useState(project);
  const [listing, setListing] = useState<Folders>();
  const [error, setError] = useState("");
  const action = useAction();
  const [location, setLocation] = useState(project);
  useEffect(() => {
    let cancelled = false;
    setError("");
    void projects<Folders>(`?path=${encodeURIComponent(location)}`)
      .then((result) => {
        if (!cancelled) {
          setListing(result);
          setPath(result.path);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [location]);
  return (
    <Dialog title="Open folder" onClose={onClose}>
      <form
        className="folder-location"
        onSubmit={(event) => {
          event.preventDefault();
          setLocation(path);
        }}
      >
        <button
          type="button"
          aria-label="Parent folder"
          disabled={!listing?.parent}
          onClick={() => setLocation(listing!.parent!)}
        >
          <ArrowUp size={16} />
        </button>
        <input
          aria-label="Folder path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button>Go</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div className="folder-list">
        {listing?.folders.map((folder) => (
          <button key={folder.path} onClick={() => setLocation(folder.path)}>
            <FolderOpen size={15} />
            {folder.name}
          </button>
        ))}
        {listing && !listing.folders.length && <p className="small-note">No subfolders</p>}
      </div>
      {!!listing?.recent.length && (
        <label className="recent-projects">
          Recent folders
          <select
            aria-label="Recent folders"
            value=""
            onChange={(event) => setLocation(event.target.value)}
          >
            <option value="">Choose folder…</option>
            {listing.recent.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={action.busy || !listing || !!error || path !== listing.path}
          onClick={() =>
            void action.run(async () => {
              await syncDocuments();
              const selected = await projects<{ id: string }>("", "POST", { path: listing!.path });
              const url = new URL(window.location.href);
              if (selected.id) url.searchParams.set("project", selected.id);
              else url.searchParams.delete("project");
              window.location.assign(url.href);
            })
          }
        >
          Open folder
        </button>
      </div>
    </Dialog>
  );
}
