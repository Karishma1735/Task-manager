import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { databasePath } from "@/lib/env";

export type Db = BetterSQLite3Database<typeof schema>;
/** A transaction handle has the same query surface as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export function openDatabase(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Fresh migrated in-memory database (tests). */
export function createTestDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

declare global {
  var __vlDb: Db | undefined;
}

/** Process-wide singleton. The database is migrated on first use so a fresh checkout just works. */
export function getDb(): Db {
  if (!globalThis.__vlDb) {
    const db = openDatabase(databasePath());
    runMigrations(db);
    globalThis.__vlDb = db;
  }
  return globalThis.__vlDb;
}
