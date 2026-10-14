import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceKnowledgeUnits } from "../../db/schema/workspaces.js"
import {
  CodesearchCheckoutError,
  globCheckoutFiles,
} from "../../domain/codeIngestion/codesearchClient.js"
import { log } from "../../observability/logger.js"
import { fitPage } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import { requireLinkedRepository } from "../framework/org-code.js"
import { checkPath, checkRepositoryPath } from "../framework/refs.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Entries that one codesearch glob gives at most. */
const GLOB_LIMIT = 5_000

type Entry = { path: string; type: "file" | "dir"; ref?: string }

function folderNotFound(path: string): McpToolError {
  return new McpToolError(
    "unknown_ref",
    `No folder "${path}". Call list_files without path to see the top level.`,
  )
}

/** Dirs first, then files; each group in path order. */
function sortEntries(entries: Entry[]): Entry[] {
  return entries.sort((a, b) =>
    a.type === b.type
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : a.type === "dir"
        ? -1
        : 1,
  )
}

/** The direct children of `folder` among the unit paths of the projection. */
async function listUnitFolder(
  orgId: string,
  workspaceId: string,
  folder: string,
): Promise<Entry[]> {
  const prefix = folder ? `${folder}/` : ""
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({ path: workspaceKnowledgeUnits.path })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.orgId, orgId),
          eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
          sql`starts_with(${workspaceKnowledgeUnits.path}, ${prefix})`,
        ),
      ),
  )
  const children = new Map<string, Entry>()
  for (const row of rows) {
    const [name, ...rest] = row.path.slice(prefix.length).split("/")
    if (!name) continue
    const path = `${prefix}${name}`
    children.set(
      path,
      rest.length > 0
        ? { path, type: "dir" }
        : { path, type: "file", ref: path },
    )
  }
  return [...children.values()]
}

export const listFilesTool = defineMcpReadTool({
  name: "list_files",
  title: "List files",
  description: [
    "List one folder of the Workspace repository (knowledge units) or of a linked repository.",
    "Without repository, it lists the Workspace repository. With repository (handle or git URL), it lists that linked repository.",
    "Each file has a ref for read_file. Send path to go into a folder, and cursor for the next page.",
    "Do not list the repository you have open locally: pass it in excludeRepositories.",
  ].join(" "),
  org: "required",
  inputShape: {
    workspace: workspaceArgument,
    repository: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "Linked repository handle or git URL. Omit for the Workspace repository.",
      ),
    path: z
      .string()
      .max(1_024)
      .optional()
      .describe(
        "Folder to list, relative to the repository root. Default: the root.",
      ),
    limit: z.number().int().min(1).max(500).optional().describe("Default 200."),
    cursor: z
      .string()
      .max(2_048)
      .optional()
      .describe("The cursor of the last result, for the next page."),
    excludeRepositories: excludeRepositoriesSchema.optional(),
  },
  outputSchema: z.object({
    repository: z
      .string()
      .nullable()
      .describe(
        "Handle of the listed repository; null for the Workspace repository.",
      ),
    path: z.string(),
    served: servedSchema,
    entries: z.array(
      z.object({
        path: z.string(),
        type: z.enum(["file", "dir"]),
        ref: z.string().optional(),
      }),
    ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "The folder has more entries than one listing holds, or an entry was cut.",
      ),
    cursor: z.string().optional(),
  }),
  async run(input, { org }) {
    const trimmed = (input.path ?? "").replace(/\/+$/, "")
    const folder =
      trimmed === ""
        ? ""
        : input.repository === undefined
          ? checkPath(trimmed, input.path ?? "")
          : checkRepositoryPath(trimmed, input.path ?? "")
    const workspace = await resolveCallWorkspace(org, input.workspace)
    const workspaceServed = requireServed(workspace)

    let handle: string | null = null
    let served: z.infer<typeof servedSchema> = workspaceServed
    let entries: Entry[]
    let listTruncated = false
    if (input.repository === undefined) {
      entries = await listUnitFolder(org.id, workspace.id, folder)
    } else {
      const repository = await requireLinkedRepository(
        org,
        workspace,
        input.repository,
        input.excludeRepositories ?? [],
      )
      handle = repository.handle
      served = { branch: repository.branch, sha: repository.sha }
      try {
        const found = await globCheckoutFiles({
          repositoryId: repository.repositoryId,
          orgId: org.id,
          sha: repository.sha,
          request: {
            pattern: "*",
            path: folder,
            onlyFiles: false,
            dot: true,
            limit: GLOB_LIMIT,
          },
        })
        listTruncated = found.truncated
        entries = found.entries.map((entry) =>
          entry.type === "dir"
            ? { path: entry.path, type: "dir" }
            : {
                path: entry.path,
                type: "file",
                ref: `${repository.handle}:${entry.path}`,
              },
        )
      } catch (error) {
        if (error instanceof CodesearchCheckoutError && error.status === 404) {
          throw folderNotFound(folder)
        }
        log.warn({
          step: "mcp.list_files.codesearch_failed",
          repositoryId: repository.repositoryId,
        })
        throw new McpToolError(
          "internal",
          "Code search is not available at the moment. Try again.",
        )
      }
    }
    if (entries.length === 0 && folder !== "") throw folderNotFound(folder)

    const binding = {
      orgId: org.id,
      workspaceId: workspace.id,
      sha: served.sha,
      scope: JSON.stringify(["list_files", handle, folder]),
    }
    const offset = input.cursor ? decodeCursor(input.cursor, binding) : 0
    const page = fitPage(sortEntries(entries), {
      offset,
      limit: input.limit ?? 200,
      maxTokens: 4_000,
      result: (fitted) => ({
        repository: handle,
        path: folder,
        served,
        entries: fitted,
        truncated: true,
      }),
    })
    const truncated = listTruncated || page.cut
    return {
      repository: handle,
      path: folder,
      served,
      entries: page.page,
      ...(truncated ? { truncated: true } : {}),
      ...(page.nextOffset === null
        ? {}
        : { cursor: encodeCursor({ ...binding, offset: page.nextOffset }) }),
    }
  },
})
