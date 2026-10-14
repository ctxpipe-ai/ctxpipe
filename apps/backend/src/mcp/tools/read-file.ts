import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceKnowledgeUnits } from "../../db/schema/workspaces.js"
import { fetchCheckoutFileBytes } from "../../domain/codeIngestion/codesearchClient.js"
import { log } from "../../observability/logger.js"
import { truncateText } from "../framework/budget.js"
import {
  type CallWorkspace,
  loadOrgRepositoryHandles,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { type CodeRepository, resolveCodeScope } from "../framework/org-code.js"
import { formatRef, parseRef } from "../framework/refs.js"
import { McpToolError } from "../framework/tool-errors.js"
import type { CallOrg } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/**
 * Characters of escaped text for one read. The text goes into the response
 * two times (TOON text and `structuredContent`), so two reads and the other
 * fields stay under the 24,000-character hard cap (ADR-051 §5).
 */
const READ_BUDGET_CHARS = 9_000

export const workspaceArgument = z
  .string()
  .min(1)
  .max(64)
  .describe("Workspace slug from list_workspaces.")

export const excludeRepositoriesArgument = z
  .array(z.string().min(1).max(512))
  .max(20)
  .optional()
  .describe(
    "Repositories the agent has open locally (handles or git URLs). Pass the output of `git remote get-url origin`. A ref into one of them gives excluded_repository.",
  )

/** The branch and SHA of the content. A repository checkout can have no SHA. */
export const servedSchema = z.object({
  branch: z.string(),
  sha: z.string().nullable(),
})

/**
 * One linked repository of the Workspace, ready to read from its published
 * checkout. Exclusion and the Workspace link are checked before any
 * codesearch request.
 */
export async function requireLinkedRepository(
  org: CallOrg,
  workspace: CallWorkspace,
  repository: string,
  excludeRepositories: readonly string[],
): Promise<CodeRepository> {
  const scope = await resolveCodeScope(org, {
    workspaceId: workspace.id,
    repositories: [repository],
    excludeRepositories,
  })
  const [excluded] = scope.excluded
  if (excluded) {
    throw new McpToolError(
      "excluded_repository",
      `The call excludes "${excluded}". Read that repository from the local checkout.`,
    )
  }
  const [linked] = scope.repositories
  if (linked) return linked
  throw new McpToolError(
    "workspace_not_ready",
    `Repository "${scope.skipped[0]?.repository ?? repository}" has no index yet. Try again in a few minutes.`,
  )
}

async function readUnit(
  org: CallOrg,
  workspace: CallWorkspace,
  path: string,
): Promise<string | null> {
  const [row] = await withOrgDbContext(org.id, (db) =>
    db
      .select({ body: workspaceKnowledgeUnits.body })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.orgId, org.id),
          eq(workspaceKnowledgeUnits.workspaceId, workspace.id),
          eq(workspaceKnowledgeUnits.path, path),
        ),
      )
      .limit(1),
  )
  return row?.body ?? null
}

/** The published checkout of the repository; codesearch keeps the read inside it. */
async function readRepositoryFile(
  org: CallOrg,
  repository: CodeRepository,
  path: string,
): Promise<string | null> {
  let bytes: Uint8Array | null
  try {
    bytes = await fetchCheckoutFileBytes({
      repositoryId: repository.repositoryId,
      orgId: org.id,
      path,
    })
  } catch {
    log.warn({
      step: "mcp.read_file.codesearch_failed",
      repositoryId: repository.repositoryId,
    })
    throw new McpToolError(
      "internal",
      "Code search is not available at the moment. Try again.",
    )
  }
  if (bytes === null) return null
  if (bytes.subarray(0, 8_000).includes(0)) {
    throw new McpToolError(
      "invalid_argument",
      `"${path}" is a binary file. read_file reads only text.`,
    )
  }
  return Buffer.from(bytes).toString("utf-8")
}

/** The lines of a text; a final newline does not make an empty last line. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines.at(-1) === "") lines.pop()
  return lines
}

/** Characters of a line in JSON and TOON text, with its newline. */
function escapedLength(line: string): number {
  return JSON.stringify(line).length - 1
}

/**
 * Lines from `startLine` to `endLine` within the read budget. A page always
 * has one line; a line over the budget is cut, and the read marks
 * `truncated`.
 */
export function readLines(
  text: string,
  range: { startLine: number; endLine?: number },
): {
  content: string
  startLine: number
  endLine: number
  totalLines: number
  nextStartLine: number | null
  truncated: boolean
} {
  const lines = splitLines(text)
  const totalLines = lines.length
  const last = Math.min(range.endLine ?? totalLines, totalLines)
  const page: string[] = []
  let used = 0
  let truncated = false
  for (let index = range.startLine - 1; index < last; index += 1) {
    const line = lines[index] as string
    const cost = escapedLength(line)
    if (page.length > 0 && used + cost > READ_BUDGET_CHARS) break
    if (cost > READ_BUDGET_CHARS) {
      let cut = truncateText(line, READ_BUDGET_CHARS)
      while (escapedLength(cut) > READ_BUDGET_CHARS) {
        cut = truncateText(cut, Math.floor(cut.length * 0.8))
      }
      page.push(cut)
      truncated = true
      break
    }
    page.push(line)
    used += cost
  }
  const endLine = range.startLine - 1 + page.length
  return {
    content: page.join("\n"),
    startLine: range.startLine,
    endLine,
    totalLines,
    nextStartLine: endLine < last ? endLine + 1 : null,
    truncated,
  }
}

export const readFileTool = defineMcpReadTool({
  name: "read_file",
  title: "Read file",
  description: [
    "Read a knowledge unit or a linked repository file by ref, with a line range.",
    "A unit ref is its path (knowledge/services/api.md). A repository file ref is <handle>:<path> (example/api:src/index.ts).",
    "Use refs from search_knowledge, search_code, find_symbol, get_related, or list_files.",
    "A long file comes in pages: send nextStartLine as startLine for the next page.",
    "Do not read the repository you have open locally: pass it in excludeRepositories.",
  ].join(" "),
  org: "required",
  inputShape: {
    workspace: workspaceArgument,
    ref: z.string().min(1).max(1_024).describe("Unit path or <handle>:<path>."),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("First line, 1-based. Default 1."),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Last line, inclusive."),
    excludeRepositories: excludeRepositoriesArgument,
  },
  outputSchema: z.object({
    ref: z.string(),
    served: servedSchema,
    content: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    totalLines: z.number(),
    nextStartLine: z
      .number()
      .nullable()
      .describe("Send as startLine to read on. Null at the end of the range."),
    truncated: z.boolean().describe("A line was cut at the size limit."),
  }),
  async run(input, { org }) {
    const startLine = input.startLine ?? 1
    if (input.endLine !== undefined && input.endLine < startLine) {
      throw new McpToolError(
        "invalid_argument",
        "endLine must not be before startLine.",
      )
    }
    const workspace = await resolveCallWorkspace(org, input.workspace)
    const workspaceServed = requireServed(workspace)
    const ref = parseRef(input.ref, await loadOrgRepositoryHandles(org))
    let text: string | null
    let served: z.infer<typeof servedSchema>
    if (ref.kind === "unit") {
      text = await readUnit(org, workspace, ref.path)
      served = workspaceServed
    } else {
      const repository = await requireLinkedRepository(
        org,
        workspace,
        ref.handle,
        input.excludeRepositories ?? [],
      )
      text = await readRepositoryFile(org, repository, ref.path)
      served = { branch: repository.branch, sha: repository.sha }
    }
    if (text === null) {
      throw new McpToolError(
        "unknown_ref",
        `No file "${input.ref}". Use a ref from a result or from list_files.`,
      )
    }
    const lines = readLines(text, { startLine, endLine: input.endLine })
    if (startLine > lines.totalLines && lines.totalLines > 0) {
      throw new McpToolError(
        "invalid_argument",
        `startLine ${startLine} is after the last line (${lines.totalLines}).`,
      )
    }
    return { ref: formatRef(ref), served, ...lines }
  },
})
