import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Session } from "../types";

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

interface Row {
  id: string;
  directory: string;
  title: string;
  time_updated: number;
}

export async function discoverOpencode(): Promise<Session[]> {
  if (!existsSync(DB_PATH)) return [];

  let db: Database;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    return [];
  }

  try {
    const rows = db
      .query<Row, []>(
        `SELECT id, directory, title, time_updated
           FROM session
          WHERE time_archived IS NULL
            AND directory IS NOT NULL
            AND directory != ''
          ORDER BY time_updated DESC`,
      )
      .all();

    return rows.map((r) => ({
      tool: "opencode" as const,
      id: r.id,
      title: r.title || `session ${r.id.slice(-8)}`,
      directory: r.directory,
      updatedAt: r.time_updated,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}
