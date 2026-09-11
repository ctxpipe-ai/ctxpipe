import { defineSandbox } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { initLogger } from "evlog"
import { closeDb, initDb } from "../db/client.js"
import { postgresSandboxInstanceStore } from "../domain/workspaces/sandbox-instance-store.js"
import { postgresSandboxLocks } from "../domain/workspaces/sandbox-lock-store.js"

initLogger({ enabled: false })
const [orgId, workspaceId, containerName, mode] = process.argv.slice(2)
if (
  !orgId ||
  !workspaceId ||
  !containerName ||
  !mode ||
  !process.env.DATABASE_URL
)
  throw new Error("Native sandbox owner fixture arguments missing")
initDb(process.env.DATABASE_URL)
const controller = new AbortController()
const definition = defineSandbox({
  id: "native-replica-proof",
  provider: dockerSandbox({ image: "node:22", containerName }),
  lifecycle: { reuse: "thread", snapshot: "none" },
})
const context = {
  threadId: "shared-thread",
  runId: containerName,
  tenant: { orgId },
  store: postgresSandboxInstanceStore({ orgId, workspaceId }),
  locks: postgresSandboxLocks(orgId, controller),
  signal: controller.signal,
}
try {
  process.stdout.write("ready\n")
  await new Promise<void>((resolve) =>
    process.stdin.once("data", () => resolve()),
  )
  if (mode === "destroy") {
    await context.locks.withLock(`sandbox:${definition.key(context)}`, () =>
      definition.destroy(context),
    )
    process.stdout.write("destroyed\n")
  } else {
    const handle = await definition.ensure(context)
    if (mode === "write") {
      const result = await handle.process.exec(
        "printf 'survives-backend-restart' > restart-proof.txt",
      )
      if (result.exitCode !== 0) throw new Error(result.stderr)
    }
    const result =
      mode === "read"
        ? await handle.process.exec("cat restart-proof.txt")
        : null
    if (result && result.exitCode !== 0) throw new Error(result.stderr)
    process.stdout.write(
      `${JSON.stringify({ id: handle.id, contents: result?.stdout })}\n`,
    )
  }
} finally {
  await closeDb()
}
