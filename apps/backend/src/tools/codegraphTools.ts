import { tool } from "langchain"
import { z } from "zod/v3"
import { repositoryIdSchema, toToon } from "../lib/agentToolRuntime.js"
import { assertStructuralGraphAnchor } from "../lib/repoExplorerPlanner.js"
import { getRepository } from "../models/repositories.js"
import { codesearchGraphQuery } from "./codesearchGraph.js"

const anchorSchema = z.object({
  symbol: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
})

export const graphFindSymbolTool = tool(
  async ({ repositoryId, symbol, filePath, module, checkoutKey }) => {
    const repository = await getRepository(repositoryId)
    if (!repository) {
      throw new Error(`repository not found: ${repositoryId}`)
    }
    assertStructuralGraphAnchor({ symbol, filePath, module })
    const raw = await codesearchGraphQuery(
      {
        id: repository.id,
        orgId: repository.orgId,
        zoektRepoId: repository.zoektRepoId,
        name: repository.name,
      },
      {
        primitive: "find_symbol",
        checkoutKey,
        symbol,
        filePath,
        module,
      },
    )
    return toToon(raw)
  },
  {
    name: "graph_find_symbol",
    description: `Resolve symbols to definitions using the code graph (CGC/Kùzu), not full-text search. Structural only — not for org memory or semantic recall.
Requires checkoutKey (default branch uses checkoutKey "default"). Provide symbol and/or file/module anchors.`,
    schema: z.object({
      repositoryId: repositoryIdSchema,
      checkoutKey: z.string().min(1).optional().default("default"),
      symbol: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      module: z.string().min(1).optional(),
    }),
  },
)

export const graphCallersTool = tool(
  async ({ repositoryId, symbol, filePath, module, checkoutKey, limit }) => {
    const repository = await getRepository(repositoryId)
    if (!repository) {
      throw new Error(`repository not found: ${repositoryId}`)
    }
    assertStructuralGraphAnchor({ symbol, filePath, module })
    const raw = await codesearchGraphQuery(
      {
        id: repository.id,
        orgId: repository.orgId,
        zoektRepoId: repository.zoektRepoId,
        name: repository.name,
      },
      {
        primitive: "get_callers",
        checkoutKey,
        symbol,
        filePath,
        module,
        limit,
      },
    )
    return toToon(raw)
  },
  {
    name: "graph_get_callers",
    description: `List callers of a function/method via the code graph (CGC). Use Zoekt search for text discovery first. Requires symbol/file/module anchor.`,
    schema: anchorSchema.extend({
      repositoryId: repositoryIdSchema,
      checkoutKey: z.string().min(1).optional().default("default"),
      limit: z.number().int().positive().max(200).optional(),
    }),
  },
)

export const graphCalleesTool = tool(
  async ({ repositoryId, symbol, filePath, module, checkoutKey, limit }) => {
    const repository = await getRepository(repositoryId)
    if (!repository) {
      throw new Error(`repository not found: ${repositoryId}`)
    }
    assertStructuralGraphAnchor({ symbol, filePath, module })
    const raw = await codesearchGraphQuery(
      {
        id: repository.id,
        orgId: repository.orgId,
        zoektRepoId: repository.zoektRepoId,
        name: repository.name,
      },
      {
        primitive: "get_callees",
        checkoutKey,
        symbol,
        filePath,
        module,
        limit,
      },
    )
    return toToon(raw)
  },
  {
    name: "graph_get_callees",
    description: `List callees from a symbol via the code graph (CGC). Use Zoekt search for text discovery first.`,
    schema: anchorSchema.extend({
      repositoryId: repositoryIdSchema,
      checkoutKey: z.string().min(1).optional().default("default"),
      limit: z.number().int().positive().max(200).optional(),
    }),
  },
)
