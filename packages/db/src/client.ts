import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { MIGRATION_SQL } from "./migrate.js";
import * as schema from "./schema.js";

export type AgentPhoneDatabase = BetterSQLite3Database<typeof schema>;

export type OpenDatabase = {
  db: AgentPhoneDatabase;
  close: () => void;
};

// better-sqlite3's native build is skipped in this environment. Node 22's
// built-in sqlite speaks the same prepare/run/all/get surface Drizzle uses.
type RowStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  raw?: () => RowStatement;
};

export function openDatabase(path: string): OpenDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec(MIGRATION_SQL);
  const client = {
    prepare(sql: string): RowStatement {
      const statement = sqlite.prepare(sql);
      const bind = (params: unknown[]) => params as never[];
      const arrays: RowStatement = {
        run: (...params: unknown[]) => statement.run(...bind(params)),
        get: (...params: unknown[]) => {
          const row = statement.get(...bind(params)) as Record<string, unknown> | undefined;
          return row ? Object.values(row) : undefined;
        },
        all: (...params: unknown[]) =>
          (statement.all(...bind(params)) as Record<string, unknown>[]).map((row) => Object.values(row)),
      };
      return {
        run: arrays.run,
        get: (...params: unknown[]) => statement.get(...bind(params)),
        all: (...params: unknown[]) => statement.all(...bind(params)) as unknown[],
        raw: () => arrays,
      };
    },
    exec(sql: string) {
      sqlite.exec(sql);
    },
    transaction<T>(fn: (...args: never[]) => T) {
      const wrapped = (...args: never[]) => {
        sqlite.exec("BEGIN");
        try {
          const result = fn(...args);
          sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      return Object.assign(wrapped, {
        deferred: wrapped,
        immediate: wrapped,
        exclusive: wrapped,
      });
    },
  };
  const db = drizzle(client as never, { schema });
  return {
    db,
    close: () => sqlite.close(),
  };
}
