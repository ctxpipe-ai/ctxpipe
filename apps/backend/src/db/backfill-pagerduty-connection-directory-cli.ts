import { config } from "dotenv"
import { backfillMissingPagerdutyConnectionDirectory } from "./backfill-pagerduty-connection-directory.js"
import { closeDb, initDb } from "./client.js"

/** Owner-role migrate jobs only provide DATABASE_URL — do not parse app env. */
export async function runBackfillMissingPagerdutyConnectionDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const url = env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  initDb(url)
  try {
    return await backfillMissingPagerdutyConnectionDirectory()
  } finally {
    await closeDb()
  }
}

const invokedDirectly = process.argv[1]?.includes(
  "backfill-pagerduty-connection-directory-cli.ts",
)

if (invokedDirectly) {
  config({ path: ".env.local", quiet: true })
  config({ path: ".env", quiet: true })
  await runBackfillMissingPagerdutyConnectionDirectoryFromEnv()
}
