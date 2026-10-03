import { reconstructChat } from "@tanstack/ai-persistence"
import { initLogger } from "evlog"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, initDb } from "../db/client.js"
import { workspaceChatPersistence } from "../domain/workspaces/workspace-chat-persistence.js"

initLogger({ enabled: false })
const [orgId, conversationId] = process.argv.slice(2)
if (!orgId || !conversationId || !process.env.DATABASE_URL)
  throw new Error("Native transcript fixture arguments missing")
initDb(process.env.DATABASE_URL)
try {
  const result = await withOrgIdContext({ id: orgId, slug: orgId }, () =>
    reconstructChat(
      workspaceChatPersistence(),
      new Request(`http://native.test/reconstruct?threadId=${conversationId}`),
      { authorize: (threadId) => threadId === conversationId },
    ),
  )
  process.stdout.write(`${JSON.stringify(await result.json())}\n`)
} finally {
  await closeDb()
}
