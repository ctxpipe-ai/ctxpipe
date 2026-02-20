import { tool } from "langchain"
import { listRepositories } from "src/models/repositories.js"
import { z } from "zod"
import { toToon } from "../lib/agentToolRuntime.js"

export const listRepositoriesTool = tool(
  async ({ includeNotReady }) => {
    const repositories = await listRepositories(includeNotReady)
    return toToon({ repositories })
  },
  {
    name: "list_repositories",
    description: [
      "Tool: list_repositories",
      "- Purpose: Load repositories available to the current org/session context.",
      "- Input: { includeNotReady? } where default includes all repositories.",
      "- Output: TOON text with repository list.",
      "- Important: repository ids use prefix repo_ and should be used by other tools.",
    ].join("\n"),
    schema: z.object({
      includeNotReady: z.boolean().default(true),
    }),
  },
)
