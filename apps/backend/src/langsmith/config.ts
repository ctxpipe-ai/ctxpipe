import { writeFileSync } from "node:fs"
import { join } from "node:path"
import * as graphs from "../graphs"

interface LangGraphConfig {
  $schema: string
  graphs: Record<string, string>
  node_version: string
  env: string
}

/**
 * Scans src/graphs/*.ts (excluding index.ts) and generates langgraph.json.
 * Convention: each file exports `graph`, graph ID = filename without extension.
 */
export function generateLangGraphConfig(): LangGraphConfig {
  return {
    $schema: "https://langgra.ph/schema.json",
    graphs: Object.keys(graphs).reduce(
      (acc: Record<string, string>, key: string) => {
        acc[key] = `./src/graphs/index.ts:${key}`
        return acc
      },
      {} as Record<string, string>,
    ),
    node_version: "20",
    env: ".env.local",
  }
}

/**
 * Writes langgraph.json to the backend directory.
 */
export function writeLangGraphConfig(config: LangGraphConfig): void {
  const path = join(process.cwd(), "langgraph.json")
  writeFileSync(path, JSON.stringify(config, null, 2))
}
