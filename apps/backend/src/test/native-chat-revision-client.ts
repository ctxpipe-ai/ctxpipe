import { initLogger } from "evlog"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, initDb } from "../db/client.js"
import { warmTanstackWorkspaceChat } from "../domain/workspaces/tanstack-workspace-chat.js"
import { withTestLogger } from "./with-test-logger.js"

initLogger({ enabled: false })
const [orgId, workspaceId, conversationId, remote, sha] = process.argv.slice(2)
if (
  !orgId ||
  !workspaceId ||
  !conversationId ||
  !remote ||
  !sha ||
  !process.env.DATABASE_URL
)
  throw new Error("Native revision client arguments missing")
initDb(process.env.DATABASE_URL)
try {
  const result = await withOrgIdContext({ id: orgId, slug: orgId }, () =>
    withTestLogger(() =>
      warmTanstackWorkspaceChat({
        orgId,
        orgSlug: orgId,
        workspaceId,
        conversationId,
        desiredUrl: remote,
        desiredSha: sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }),
    ),
  )
  if (!result.ok) throw new Error(result.error)
  process.stdout.write(`${JSON.stringify({ id: result.handle.id })}\n`)
} finally {
  await closeDb()
}
