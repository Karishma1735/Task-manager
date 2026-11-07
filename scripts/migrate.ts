import { openDatabase, runMigrations } from "../src/db";
import { databasePath } from "../src/lib/env";

const db = openDatabase(databasePath());
runMigrations(db);
console.log(`Migrations applied to ${databasePath()}`);
