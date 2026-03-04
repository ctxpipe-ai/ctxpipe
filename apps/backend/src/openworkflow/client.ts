import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"

const backend = await BackendPostgres.connect(process.env.DATABASE_URL!)
export const ow = new OpenWorkflow({ backend })
