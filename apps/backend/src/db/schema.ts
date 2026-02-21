import { defineRelations } from "drizzle-orm"
import { repositoryIngestionErrors } from "./schema/repositoryIngestionErrors.js"
import { repositoryIngestionQueue } from "./schema/repositoryIngestionQueue.js"
import { repositories } from "./schema/repositories.js"

const schema = {
  repositories,
  repositoryIngestionQueue,
  repositoryIngestionErrors,
} as const

const relations = defineRelations(schema)

export { schema, relations }
