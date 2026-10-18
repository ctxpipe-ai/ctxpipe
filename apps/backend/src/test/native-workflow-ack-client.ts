import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { withOrgIdContext } from "../auth/withAuth.js"
import { initDb } from "../db/client.js"
import { enqueueWriteJob } from "../openworkflow/enqueue-workspace-write-commit.js"

initLogger({ enabled: false })
// The parent's msw does not reach this process. Without this server, the
// write probe asked the real api.github.com for an installation token, and a
// slow or failed GitHub answer held admission past the parent's timeout. The
// fixture app is not real, so GitHub refused it with a 401: give that answer
// here. A network error is not a stand-in, because Octokit retries it for 14 s.
setupServer(
  http.all("https://api.github.com/*", () =>
    HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
  ),
).listen({ onUnhandledRequest: "error" })
// stdout carries only the JSON result; postgres.js prints server notices with console.log.
console.log = console.error
const [orgId, workspaceId, jobId] = process.argv.slice(2)
if (!orgId || !workspaceId || !jobId || !process.env.DATABASE_URL)
  throw new Error("Native admission fixture arguments missing")
initDb(process.env.DATABASE_URL)
const result = await withOrgIdContext({ id: orgId, slug: "native-ack" }, () =>
  enqueueWriteJob(
    {
      orgId,
      workspaceId,
      jobId,
      kind: "ui_file_edit",
      mergeFiles: [
        {
          path: "knowledge/accepted.md",
          content: "# Accepted native command\n",
        },
      ],
    },
    { error: () => undefined },
  ),
)
process.stdout.write(JSON.stringify(result))
process.exit(0)
