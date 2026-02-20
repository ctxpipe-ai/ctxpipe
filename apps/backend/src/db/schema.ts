import { defineRelations } from "drizzle-orm"
import { repositories } from "./schema/repositories.js"

const schema = {
  repositories,
} as const

const relations = defineRelations(schema)

export { schema, relations }
