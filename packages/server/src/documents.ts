import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { Document } from "@carl/protocol";
import type { Store } from "./store.ts";
import type { Events } from "./events.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export class Conflict extends Error {
  statusCode = 409;
}
export class InvalidPath extends Error {
  statusCode = 400;
}

export class Documents {
  readonly root: string;
  private watchers = new Map<string, FSWatcher>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(
    root: string,
    private store: Store,
    private events: Events,
    private watchFiles = false,
  ) {
    this.root = realpathSync(root);
  }
  private resolve(path: string) {
    const candidate = resolve(this.root, path);
    const within = (value: string) => value.startsWith(this.root + sep);
    if (!path || !within(candidate))
      throw new InvalidPath("Path must name a file inside this project.");
    const actual = existsSync(candidate)
      ? realpathSync(candidate)
      : resolve(realpathSync(dirname(candidate)), relative(dirname(candidate), candidate));
    if (!within(actual)) throw new InvalidPath("Links outside this project cannot be opened.");
    if (
      relative(this.root, actual)
        .split(sep)
        .some((part) => part.startsWith(".") || part === "node_modules")
    )
      throw new InvalidPath("Internal project files are excluded.");
    return candidate;
  }
  list(): string[] {
    const walk = (dir: string, depth: number): string[] =>
      depth > 5
        ? []
        : readdirSync(dir, { withFileTypes: true })
            .filter(
              (entry) =>
                !entry.name.startsWith(".") &&
                !["node_modules", "dist", "target", "__pycache__"].includes(entry.name),
            )
            .flatMap((entry) =>
              entry.isDirectory()
                ? walk(resolve(dir, entry.name), depth + 1)
                : entry.isFile()
                  ? [relative(this.root, resolve(dir, entry.name))]
                  : [],
            );
    return walk(this.root, 0).sort().slice(0, 1000);
  }
  private readDisk(path: string): { content: string; hash: string } | null {
    const full = this.resolve(path);
    if (!existsSync(full)) return null;
    if (statSync(full).size > 2_000_000)
      throw new InvalidPath("File exceeds the 2 MB text-read limit.");
    const content = readFileSync(full, "utf8");
    if (content.includes("\0")) throw new InvalidPath("Binary file; a text document is required.");
    return { content, hash: digest(content) };
  }
  private observe(path: string) {
    const directory = dirname(this.resolve(path));
    if (!this.watchFiles || this.closed || this.watchers.has(directory)) return;
    const watcher = watch(directory, () => {
      clearTimeout(this.refreshTimers.get(directory));
      this.refreshTimers.set(
        directory,
        setTimeout(() => {
          this.refreshTimers.delete(directory);
          if (this.closed) return;
          for (const doc of this.store.list<Document>("document")) {
            if (dirname(resolve(this.root, doc.path)) !== directory) continue;
            try {
              this.open(doc.path);
            } catch {
              /* A later open reports unreadable files; retain the working document. */
            }
          }
        }, 75),
      );
    });
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(directory);
    });
    watcher.unref();
    this.watchers.set(directory, watcher);
  }
  private publish(doc: Document, revision = false): Document {
    this.store.transaction(() => {
      if (revision) this.store.put("document-revision", `${doc.path}:${doc.version}`, doc);
      this.store.put("document", doc.path, doc);
    });
    this.events.emit({ type: "document", document: doc });
    return doc;
  }
  open(path: string): Document {
    this.resolve(path);
    const old = this.store.get<Document>("document", path);
    const disk = this.readDisk(path);
    this.observe(path);
    if (!old) {
      if (!disk) throw new InvalidPath("The project file does not exist.");
      return this.publish(
        { path, content: disk.content, version: 1, savedVersion: 1, diskHash: disk.hash },
        true,
      );
    }
    // Also recovers a crash after rename but before the saved revision was recorded.
    if (disk?.content === old.content) {
      if (old.savedVersion !== old.version || old.diskHash !== disk.hash || old.diskConflict)
        return this.publish({
          ...old,
          savedVersion: old.version,
          diskHash: disk.hash,
          diskConflict: undefined,
        });
      return old;
    }
    if (disk?.hash === old.diskHash) {
      return old.diskConflict ? this.publish({ ...old, diskConflict: undefined }) : old;
    }
    if (disk && old.version === old.savedVersion) {
      const version = old.version + 1;
      return this.publish(
        {
          ...old,
          content: disk.content,
          version,
          savedVersion: version,
          diskHash: disk.hash,
          diskConflict: undefined,
          editId: undefined,
        },
        true,
      );
    }
    const diskConflict = { hash: disk?.hash ?? null, content: disk?.content ?? null };
    return old.diskConflict?.hash === diskConflict.hash
      ? old
      : this.publish({ ...old, diskConflict });
  }
  edit(path: string, content: string, expectedVersion: number, editId?: string): Document {
    const previous = this.open(path);
    // A lost HTTP acknowledgement may be retried after a reconnect.
    if (editId && previous.editId === editId && previous.content === content) return previous;
    if (previous.version !== expectedVersion)
      throw new Conflict("The document changed. Review its current version before editing.");
    if (previous.content === content)
      return editId && editId !== previous.editId
        ? this.publish({ ...previous, editId })
        : previous;
    return this.publish({ ...previous, content, version: previous.version + 1, editId }, true);
  }
  save(path: string, expectedVersion: number): Document {
    const doc = this.open(path);
    if (doc.version !== expectedVersion)
      throw new Conflict("The document changed. Review the current version before saving.");
    if (doc.diskConflict)
      throw new Conflict("The file changed on disk. Review both versions before saving.");
    return this.write(doc, doc.diskHash);
  }
  private write(doc: Document, expectedDiskHash: string | null): Document {
    const full = this.resolve(doc.path);
    if ((this.readDisk(doc.path)?.hash ?? null) !== expectedDiskHash)
      throw new Conflict("The file changed on disk again. Review it before saving.");
    const temporary = `${full}.carl-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, doc.content, {
        flag: "wx",
        mode: existsSync(full) ? statSync(full).mode : 0o644,
      });
      renameSync(temporary, full);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return this.publish({
      ...doc,
      savedVersion: doc.version,
      diskHash: digest(doc.content),
      diskConflict: undefined,
    });
  }
  reconcile(
    path: string,
    expectedVersion: number,
    expectedDiskHash: string | null,
    choice: "disk" | "working",
  ): Document {
    const doc = this.open(path);
    const disk = this.readDisk(path);
    if (doc.version !== expectedVersion || (disk?.hash ?? null) !== expectedDiskHash)
      throw new Conflict(
        "A version changed while you were reviewing it. Review the latest versions.",
      );
    if (choice === "working") return this.write(doc, expectedDiskHash);
    if (!disk) throw new Conflict("The file was deleted. Keep the working version to recreate it.");
    const version = doc.version + 1;
    return this.publish(
      {
        ...doc,
        content: disk.content,
        version,
        savedVersion: version,
        diskHash: disk.hash,
        diskConflict: undefined,
        editId: undefined,
      },
      true,
    );
  }
  close() {
    this.closed = true;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.refreshTimers.clear();
    this.watchers.clear();
  }
  verifyReference(path: string, version: number, code: string) {
    const revision = this.store.get<Document>("document-revision", `${path}:${version}`);
    if (!revision || revision.content !== code)
      throw new Conflict("Execution must reference the exact document revision being run.");
  }
}
