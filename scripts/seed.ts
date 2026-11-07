import { openDatabase, runMigrations } from "../src/db";
import { databasePath } from "../src/lib/env";
import { accountsFromEnv, seedUsers } from "../src/lib/seed";

async function main() {
  const db = openDatabase(databasePath());
  runMigrations(db);
  const res = await seedUsers(db, accountsFromEnv(), new Date(), {
    resetPasswords: process.env.SEED_RESET_PASSWORDS === "1",
  });
  console.log("Seed complete:", res);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
