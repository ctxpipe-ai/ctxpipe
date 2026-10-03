import { initLogger } from "evlog"
import { closeDb, initDb } from "../db/client.js"
import { postgresSandboxLocks } from "../domain/workspaces/sandbox-lock-store.js"

initLogger({ enabled: false })
const [orgId, key, mode] = process.argv.slice(2)
if (!orgId || !key || !mode || !process.env.DATABASE_URL)
  throw new Error("Native sandbox lock fixture arguments missing")
initDb(process.env.DATABASE_URL)
process.stdout.write("ready\n")
try {
  await postgresSandboxLocks(orgId).withLock(key, async (signal) => {
    signal.throwIfAborted()
    process.stdout.write("entered\n")
    if (mode === "hold")
      await new Promise<void>((resolve) =>
        process.stdin.once("data", () => resolve()),
      )
    signal.throwIfAborted()
  })
  process.stdout.write("released\n")
} finally {
  await closeDb()
}
