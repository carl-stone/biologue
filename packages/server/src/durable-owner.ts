import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

/** A transaction protects ownership checks; Pi Durable itself requires a single writer. */
export function acquireDurableOwner(path: string) {
  const db = new DatabaseSync(path);
  const token = randomUUID();
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, host TEXT NOT NULL, token TEXT NOT NULL)`);
    db.exec("BEGIN IMMEDIATE");
    const owner = db.prepare("SELECT pid,host FROM owner WHERE id=1").get() as
      { pid: number; host: string } | undefined;
    if (owner) {
      let alive = true;
      if (owner.host === hostname()) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
      }
      if (alive)
        throw new Error(
          `The project's Pi Durable harness is already owned by process ${owner.pid} on ${owner.host}. Close that application before opening this project.`,
        );
    }
    db.prepare("INSERT OR REPLACE INTO owner(id,pid,host,token) VALUES(1,?,?,?)").run(
      process.pid,
      hostname(),
      token,
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    db.prepare("DELETE FROM owner WHERE id=1 AND token=?").run(token);
    db.close();
    closed = true;
  };
}
