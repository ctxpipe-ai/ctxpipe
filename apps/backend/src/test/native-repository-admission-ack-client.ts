import { initLogger } from "evlog"
import { initDb } from "../db/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../openworkflow/enqueue-repository-ingestion.js"

initLogger({ enabled: false })
const [orgId, repositoryId] = process.argv.slice(2)
if (!orgId || !repositoryId || !process.env.DATABASE_URL)
  throw new Error("Native repository admission fixture arguments missing")
initDb(process.env.DATABASE_URL)
const result = await enqueueRepositoryIngestionWorkflow(
  { orgId, repositoryId },
  { error: () => undefined },
)
process.stdout.write(JSON.stringify(result))
process.exit(0)
