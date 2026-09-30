import { readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppOptions, createApp } from "./app.ts";
import type { Store } from "./store.ts";
import { PiAdapter } from "./pi.ts";

type Workspace = Awaited<ReturnType<typeof createApp>>;
/** URL-scoped workspaces keep separate browser tabs and kernel queues isolated. */
export function projectRoutes(app: FastifyInstance, options: AppOptions, store: Store) {
  const opened = new Map<string, Promise<Workspace>>();
  const known = new Map<string, string>(
    Object.entries(store.get<Record<string, string>>("settings", "projects") ?? {}),
  );
  const root = options.jupyterRoot ?? options.project;
  async function folder(path: string) {
    const canonical = await realpath(path);
    const rel = relative(root, canonical);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw Object.assign(new Error(`Choose a folder within ${root}.`), { statusCode: 400 });
    if (!(await stat(canonical)).isDirectory())
      throw Object.assign(new Error("Choose a folder."), { statusCode: 400 });
    return canonical;
  }
  async function workspace(id: string) {
    if (!known.has(id))
      throw Object.assign(new Error("Project not found. Open its folder again."), {
        statusCode: 404,
      });
    let loading = opened.get(id);
    if (!loading) {
      loading = (async () => {
        const project = await folder(known.get(id)!);
        const stateDir = join(project, ".biologue");
        const { createApp } = await import("./app.ts");
        const child = await createApp({
          ...options,
          project,
          stateDir,
          projects: false,
          kernel: undefined,
          pi: new PiAdapter({ project, stateDir, authDir: join(options.stateDir, "pi") }),
        });
        await child.app.ready();
        return child;
      })();
      opened.set(id, loading);
      void loading.catch(() => opened.delete(id));
    }
    return loading;
  }
  app.addHook("onRequest", async (request, reply) => {
    const match = request.raw.url?.match(/^\/projects\/([a-f0-9]{24})(\/api(?:\/|\?|$).*)/);
    if (!match) return;
    const child = await workspace(match[1]);
    request.raw.url = match[2];
    reply.hijack();
    child.app.routing(request.raw, reply.raw);
  });
  app.get("/api/projects", async (request) => {
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    const path = await folder(query.path || options.project);
    const entries = await readdir(path, { withFileTypes: true });
    return {
      path,
      parent: path === root ? null : dirname(path),
      folders: entries
        .filter(
          (entry) =>
            entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
        )
        .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      recent: [options.project, ...known.values()],
    };
  });
  app.post("/api/projects", async (request) => {
    const project = await folder(z.object({ path: z.string().min(1) }).parse(request.body).path);
    if (project === options.project) return { id: "", project };
    const id = createHash("sha256").update(project).digest("hex").slice(0, 24);
    known.set(id, project);
    await workspace(id);
    store.put("settings", "projects", Object.fromEntries(known));
    return { id, project };
  });
  app.addHook("preClose", async () => {
    await Promise.all(
      [...opened.values()].map(async (loading) => {
        const child = await loading.catch(() => null);
        await child?.app.close();
      }),
    );
  });
}
