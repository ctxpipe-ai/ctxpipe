import { z } from "zod"

import {
  CodesearchCheckoutError,
  globCheckoutFiles,
} from "../../domain/codeIngestion/codesearchClient.js"
import { servedKnowledgeHead } from "../../knowledge-reader/knowledge-reader.js"
import {
  listPlaneUnitFiles,
  type UnitFile,
} from "../../knowledge-reader/plane-files.js"
import { knowledgeViewKey } from "../../models/knowledge-state.js"
import { log } from "../../observability/logger.js"
import { fitPage } from "../framework/budget.js"
import {
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "../framework/cursor.js"
import {
  type KnowledgeNotice,
  knowledgeNoticesSchema,
  legacyKnowledgeNotices,
  withNotices,
} from "../framework/legacy-knowledge.js"
import {
  pathGlobRegex,
  requireLinkedRepository,
} from "../framework/org-code.js"
import { checkPath, checkRepositoryPath } from "../framework/refs.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  branchArgument,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Entries that one codesearch glob gives at most. */
const GLOB_LIMIT = 5_000

type Entry = {
  path: string
  type: "file" | "dir"
  ref?: string
  size?: number
  units?: number
}

/** A brace glob for the entries at most `depth` levels below a folder. */
function depthPattern(depth: number): string {
  const levels = Array.from({ length: depth }, (_, index) =>
    Array.from({ length: index + 1 }, () => "*").join("/"),
  )
  return levels.length === 1 ? "*" : `{${levels.join(",")}}`
}

function folderNotFound(path: string): McpToolError {
  return new McpToolError(
    "unknown_ref",
    `No folder "${path}". Call list_files without path to see the top level.`,
  )
}

/** Path order, so that the entries of a folder come after it. */
function sortEntries(entries: Entry[]): Entry[] {
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
}

/**
 * The entries at most `depth` levels below `folder` among the unit files
 * below it. A file has its size in bytes; a folder has the number of units
 * below it, at any depth.
 */
function folderEntries(
  units: readonly UnitFile[],
  folder: string,
  depth: number,
): Entry[] {
  const prefix = folder ? `${folder}/` : ""
  const entries = new Map<string, Entry>()
  for (const unit of units) {
    const parts = unit.path.slice(prefix.length).split("/")
    if (parts.some((part) => !part)) continue
    for (let level = 1; level <= Math.min(depth, parts.length); level++) {
      const path = `${prefix}${parts.slice(0, level).join("/")}`
      if (level === parts.length) {
        entries.set(path, { path, type: "file", ref: path, size: unit.size })
      } else {
        const dir = entries.get(path) ?? { path, type: "dir", units: 0 }
        dir.units = (dir.units ?? 0) + 1
        entries.set(path, dir)
      }
    }
  }
  return [...entries.values()]
}

export const listFilesTool = defineMcpReadTool({
  name: "list_files",
  title: "List files",
  description: [
    "List a folder tree of the Workspace repository (knowledge units) or of a linked repository, two levels deep by default. A unit folder shows how many units it holds.",
    "Without repository, it lists the Workspace repository. With repository (handle or git URL), it lists that linked repository.",
    "Each file has a ref for read_file. Send path to go into a folder, and cursor for the next page.",
    "Do not list the repository you have open locally: pass it in excludeRepositories.",
  ].join(" "),
  org: "required",
  inputShape: {
    workspace: workspaceArgument,
    branch: branchArgument.describe(
      "For the Workspace repository: a branch of it. Default: the default branch. A branch can be listed after a commit on it is projected.",
    ),
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
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(2)
      .describe("Folder levels to list below path. Default 2, at most 5."),
    glob: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "Only files whose path below path matches this glob, such as **/*.md. With glob, folders are not listed.",
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
        size: z
          .number()
          .int()
          .optional()
          .describe("Bytes of a knowledge unit file."),
        units: z
          .number()
          .int()
          .optional()
          .describe("Knowledge units below a Workspace repository folder."),
      }),
    ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "The folder has more entries than one listing holds, an entry was cut, or with glob, files may lie deeper than depth.",
      ),
    cursor: z.string().optional(),
    notices: knowledgeNoticesSchema,
  }),
  describeResult: ({ entries }) => ({ count: entries.length }),
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
    // The key of the listed view, for the cursor (`knowledgeViewKey`).
    let viewKey = workspaceServed.sha
    let entries: Entry[]
    let listTruncated = false
    // The main-era knowledge that the plane does not list (CTX-1715).
    let notices: KnowledgeNotice[] = []
    if (input.repository === undefined) {
      const head = await servedKnowledgeHead(org.id, workspace.id, input.branch)
      notices = legacyKnowledgeNotices([workspace])
      viewKey = knowledgeViewKey(head)
      served = {
        branch: input.branch ?? workspaceServed.branch,
        sha: head.sha,
      }
      entries = folderEntries(
        await listPlaneUnitFiles({
          orgId: org.id,
          workspaceId: workspace.id,
          head,
          folder,
        }),
        folder,
        input.depth,
      )
    } else {
      const repository = await requireLinkedRepository(
        org,
        workspace,
        input.repository,
        input.excludeRepositories ?? [],
      )
      handle = repository.handle
      served = { branch: repository.branch, sha: repository.sha }
      viewKey = repository.sha
      try {
        const found = await globCheckoutFiles({
          repositoryId: repository.repositoryId,
          orgId: org.id,
          sha: repository.sha,
          request: {
            pattern: depthPattern(input.depth),
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
    if (entries.length === 0 && folder !== "")
      throw withNotices(folderNotFound(folder), notices)
    if (input.glob) {
      const match = new RegExp(pathGlobRegex(input.glob))
      const prefix = folder ? `${folder}/` : ""
      // A folder at the last level may hold files that the depth hides. Show
      // the miss with `truncated`.
      if (
        entries.some(
          (entry) =>
            entry.type === "dir" &&
            entry.path.slice(prefix.length).split("/").length >= input.depth,
        )
      ) {
        listTruncated = true
      }
      entries = entries.filter(
        (entry) =>
          entry.type === "file" && match.test(entry.path.slice(prefix.length)),
      )
    }

    const binding = {
      orgId: org.id,
      workspaceId: workspace.id,
      sha: viewKey,
      scope: JSON.stringify([
        "list_files",
        handle,
        folder,
        input.depth,
        input.glob ?? null,
      ]),
    }
    const offset = input.cursor ? decodeCursor(input.cursor, binding) : 0
    const page = fitPage(sortEntries(entries), {
      offset,
      limit: input.limit ?? 200,
      maxTokens: 3_000,
      result: (fitted) => ({
        repository: handle,
        path: folder,
        served,
        entries: fitted,
        truncated: true,
        ...(notices.length ? { notices } : {}),
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
      ...(notices.length ? { notices } : {}),
    }
  },
})
