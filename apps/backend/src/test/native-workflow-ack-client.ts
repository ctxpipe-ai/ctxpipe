import { initLogger } from "evlog"
import { withOrgIdContext } from "../auth/withAuth.js"
import { initDb } from "../db/client.js"
import { enqueueWriteJob } from "../openworkflow/enqueue-workspace-write-commit.js"

initLogger({ enabled: false })
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
