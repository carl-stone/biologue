import type { Document } from "@biologue/protocol";

export interface PendingEdit {
  content: string;
  baseVersion: number;
  editId: string;
}
type Callbacks = {
  send: (path: string, edit: PendingEdit) => Promise<Document>;
  changed: (documents: Document[], pending: Record<string, PendingEdit>) => void;
  persist: (path: string, edit?: PendingEdit) => void;
  error: (error: unknown) => void;
};

/** One working document with an optimistic local replica and serialized acknowledgements. */
export class DocumentSync {
  private documents = new Map<string, Document>();
  private pending: Record<string, PendingEdit> = {};
  private inflight = new Map<string, { edit: PendingEdit; promise: Promise<void> }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private connected = false;
  private disposed = false;
  constructor(
    private callbacks: Callbacks,
    private debounceMs = 250,
  ) {}
  private publish() {
    this.callbacks.changed([...this.documents.values()], { ...this.pending });
  }
  private setPending(path: string, edit?: PendingEdit) {
    if (edit) this.pending[path] = edit;
    else delete this.pending[path];
    this.callbacks.persist(path, edit);
  }
  restore(pending: Record<string, PendingEdit>) {
    for (const [path, edit] of Object.entries(pending))
      this.pending[path] = { ...edit, editId: edit.editId || crypto.randomUUID() };
    this.publish();
  }
  receive(document: Document) {
    const old = this.documents.get(document.path);
    if (old && old.version > document.version) return;
    this.documents.set(document.path, document);
    const request = this.inflight.get(document.path);
    if (request && document.editId === request.edit.editId)
      this.acknowledge(document.path, request.edit, document);
    const pending = this.pending[document.path];
    if (!request && pending?.content === document.content) this.setPending(document.path);
    this.publish();
    this.schedule(document.path);
  }
  edit(document: Document, content: string) {
    const current = this.documents.get(document.path) ?? document;
    const old = this.pending[document.path];
    // A revert while an earlier edit is in flight is itself a pending edit.
    if (content === current.content && !this.inflight.has(document.path))
      this.setPending(document.path);
    else
      this.setPending(document.path, {
        content,
        baseVersion: old?.baseVersion ?? current.version,
        editId: crypto.randomUUID(),
      });
    this.publish();
    this.schedule(document.path);
  }
  discard(path: string) {
    if (this.inflight.has(path)) throw new Error("Wait for the current edit to finish syncing.");
    this.setPending(path);
    this.publish();
  }
  keepLocal(path: string) {
    const pending = this.pending[path],
      document = this.documents.get(path);
    if (!pending || !document || this.inflight.has(path)) return;
    this.setPending(path, {
      ...pending,
      baseVersion: document.version,
      editId: crypto.randomUUID(),
    });
    this.publish();
    this.schedule(path);
  }
  connection(connected: boolean) {
    this.connected = connected;
    if (!connected) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    }
    if (connected) for (const path of Object.keys(this.pending)) this.schedule(path);
  }
  private acknowledge(path: string, sent: PendingEdit, document: Document) {
    const pending = this.pending[path];
    if (pending?.editId === sent.editId) this.setPending(path);
    else if (pending && pending.baseVersion === sent.baseVersion)
      this.setPending(path, { ...pending, baseVersion: document.version });
  }
  private schedule(path: string) {
    clearTimeout(this.timers.get(path));
    if (this.disposed || !this.connected || !this.pending[path] || this.inflight.has(path)) return;
    const document = this.documents.get(path);
    if (document?.savedAs) return;
    if (!document || document.version !== this.pending[path].baseVersion) return;
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.flush(path).catch(this.callbacks.error);
      }, this.debounceMs),
    );
  }
  async flush(path: string): Promise<Document> {
    clearTimeout(this.timers.get(path));
    if (!this.connected || this.disposed)
      throw new Error("The workspace is offline. Your edits are retained on this device.");
    while (this.pending[path] || this.inflight.has(path)) {
      if (!this.connected || this.disposed)
        throw new Error("The workspace is offline. Your edits are retained on this device.");
      const existing = this.inflight.get(path);
      if (existing) {
        await existing.promise;
        continue;
      }
      const document = this.documents.get(path),
        edit = this.pending[path];
      if (!document || document.version !== edit.baseVersion)
        throw new Error("The document changed. Review both versions before continuing.");
      const request = { edit, promise: Promise.resolve() };
      this.inflight.set(path, request);
      request.promise = (async () => {
        try {
          let saved: Document;
          try {
            saved = await this.callbacks.send(path, edit);
          } catch (error) {
            const observed = this.documents.get(path);
            if (observed?.editId !== edit.editId) throw error;
            saved = observed; // SSE acknowledgement survives a lost HTTP response.
          }
          this.acknowledge(path, edit, saved);
          this.receive(saved);
        } finally {
          this.inflight.delete(path);
          this.publish();
        }
      })();
      await request.promise;
    }
    const document = this.documents.get(path);
    if (!document) throw new Error("Document is not open.");
    return document;
  }
  close() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
