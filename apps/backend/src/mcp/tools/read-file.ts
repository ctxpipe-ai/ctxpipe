import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import {
  workspaceKnowledgeChunks,
  workspaceKnowledgeUnits,
} from "../../db/schema/workspaces.js"
import { fetchCheckoutFileBytes } from "../../domain/codeIngestion/codesearchClient.js"
import { chunkKnowledgeBody } from "../../domain/workspaces/knowledge-chunks.js"
import { log } from "../../observability/logger.js"
import { fitPage } from "../framework/budget.js"
import {
  type CallWorkspace,
  loadOrgRepositoryHandles,
  loadWorkspaceHandles,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import {
  type CodeRepository,
  requireLinkedRepository,
} from "../framework/org-code.js"
import { formatRef, parseRef } from "../framework/refs.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import type { CallOrg } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Claims that the front matter of one read shows. */
const MAX_FRONT_MATTER_CLAIMS = 20

const frontMatterSchema = z
  .object({
    kind: z.string().optional(),
    title: z.string().optional(),
    source: z.string(),
    updatedAt: z.string(),
    claims: z
      .array(
        z.object({
          to: z.string(),
          predicate: z.string().optional(),
          confidence: z.number().optional(),
          validFrom: z.string().optional(),
          validTo: z.string().optional(),
          source: z.string().optional(),
        }),
      )
      .optional(),
    moreClaims: z.number().int().optional(),
  })
  .describe(
    "The front matter of a knowledge unit, as ctxpipe parsed it: kind, title, source, last update, and claims. Only on the page that starts at the body.",
  )
type FrontMatter = z.infer<typeof frontMatterSchema>

/**
 * A unit and the file line before its first body line: the lines of front
 * matter. The chunk rows hold file lines, and the first chunk starts at its
 * body line, so the difference is the offset (ADR-051 §6). Without chunk
 * rows the offset is 0.
 */
async function readUnit(
  org: CallOrg,
  workspace: CallWorkspace,
  path: string,
): Promise<{
  text: string
  lineOffset: number
  sha: string
  frontMatter: FrontMatter
} | null> {
  return withOrgDbContext(org.id, async (db) => {
    const [row] = await db
      .select({
        servingId: workspaceKnowledgeUnits.servingId,
        body: workspaceKnowledgeUnits.body,
        projectionSha: workspaceKnowledgeUnits.projectionSha,
        kind: workspaceKnowledgeUnits.kind,
        title: workspaceKnowledgeUnits.title,
        source: workspaceKnowledgeUnits.source,
        updatedAt: workspaceKnowledgeUnits.updatedAt,
        claims: workspaceKnowledgeUnits.claims,
      })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.orgId, org.id),
          eq(workspaceKnowledgeUnits.workspaceId, workspace.id),
          eq(workspaceKnowledgeUnits.path, path),
        ),
      )
      .limit(1)
    if (!row) return null
    const [first] = await db
      .select({ startLine: workspaceKnowledgeChunks.startLine })
      .from(workspaceKnowledgeChunks)
      .where(
        and(
          eq(workspaceKnowledgeChunks.orgId, org.id),
          eq(workspaceKnowledgeChunks.workspaceId, workspace.id),
          eq(workspaceKnowledgeChunks.unitId, row.servingId),
          eq(workspaceKnowledgeChunks.ordinal, 0),
        ),
      )
      .limit(1)
    const bodyStart = chunkKnowledgeBody(row.body)[0]?.startLine
    const lineOffset =
      first && bodyStart !== undefined
        ? Math.max(0, first.startLine - bodyStart)
        : 0
    const claims: NonNullable<FrontMatter["claims"]> = row.claims
      .slice(0, MAX_FRONT_MATTER_CLAIMS)
      .map((claim) => ({
        to: claim.to,
        ...(claim.predicate !== null ? { predicate: claim.predicate } : {}),
        ...(claim.confidence !== null ? { confidence: claim.confidence } : {}),
        ...(claim.validFrom !== null ? { validFrom: claim.validFrom } : {}),
        ...(claim.validTo !== null ? { validTo: claim.validTo } : {}),
        ...(claim.source !== null ? { source: claim.source } : {}),
      }))
    return {
      text: row.body,
      lineOffset,
      sha: row.projectionSha,
      frontMatter: {
        ...(row.kind ? { kind: row.kind } : {}),
        ...(row.title ? { title: row.title } : {}),
        source: row.source ?? "authored",
        updatedAt: row.updatedAt.toISOString(),
        ...(claims.length ? { claims } : {}),
        ...(row.claims.length > claims.length
          ? { moreClaims: row.claims.length - claims.length }
          : {}),
      },
    }
  })
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
      sha: repository.sha,
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

export const readFileInputShape = {
  workspace: workspaceArgument
    .optional()
    .describe(
      "Workspace slug from list_workspaces. Needed for a unit path. For <handle>:<path> it limits the read to repositories this Workspace links.",
    ),
  ref: z.string().min(1).max(1_024).describe("Unit path or <handle>:<path>."),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First line, 1-based. Default 1."),
  endLine: z.number().int().min(1).optional().describe("Last line, inclusive."),
  excludeRepositories: excludeRepositoriesSchema.optional(),
}

const readFileOutputSchema = z.object({
  ref: z.string(),
  served: servedSchema,
  frontMatter: frontMatterSchema.optional(),
  content: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  totalLines: z.number(),
  nextStartLine: z
    .number()
    .nullable()
    .describe("Send as startLine to read on. Null at the end of the range."),
  truncated: z.boolean().describe("A line was cut at the size limit."),
})

export type ReadFileInput = z.infer<z.ZodObject<typeof readFileInputShape>>
export type ReadFileOutput = z.infer<typeof readFileOutputSchema>

/**
 * The read of `read_file`, for a call that has resolved `org`. The
 * `ctxpipe://` resource template reads through this too, so a ref has one
 * resolution and one authorization.
 */
export async function readFileByRef(
  org: CallOrg,
  input: ReadFileInput,
): Promise<ReadFileOutput> {
  const startLine = input.startLine ?? 1
  if (input.endLine !== undefined && input.endLine < startLine) {
    throw new McpToolError(
      "invalid_argument",
      "endLine must not be before startLine.",
    )
  }
  const workspace = input.workspace
    ? await resolveCallWorkspace(org, input.workspace)
    : undefined
  let ref: ReturnType<typeof parseRef>
  if (workspace) {
    const { handles, linked } = await loadWorkspaceHandles(org, workspace.id)
    ref = parseRef(input.ref, handles, linked)
  } else {
    ref = parseRef(input.ref, await loadOrgRepositoryHandles(org))
    if (ref.kind === "unit") {
      throw new McpToolError(
        "invalid_argument",
        "A knowledge unit ref needs workspace. Name the Workspace, or read a repository file as <handle>:<path>.",
      )
    }
  }
  let text: string | null
  let frontMatter: FrontMatter | undefined
  let lineOffset = 0
  let served: z.infer<typeof servedSchema>
  if (ref.kind === "unit") {
    if (!workspace) throw new Error("A unit ref has a Workspace")
    const workspaceServed = requireServed(workspace)
    const unit = await readUnit(org, workspace, ref.path)
    text = unit?.text ?? null
    frontMatter = unit?.frontMatter
    lineOffset = unit?.lineOffset ?? 0
    served = {
      branch: workspaceServed.branch,
      sha: unit?.sha ?? workspaceServed.sha,
    }
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
      `No file "${input.ref.slice(0, 200)}". Use a ref from a result or from list_files.`,
    )
  }
  // File lines: the first line of the text is line `lineOffset + 1`. Lines
  // of front matter are not in a unit text, so a read starts at its body.
  const lines = splitLines(text)
  const totalLines = lineOffset + lines.length
  const last = Math.min(input.endLine ?? totalLines, totalLines)
  if (input.endLine !== undefined && last <= lineOffset) {
    throw new McpToolError(
      "invalid_argument",
      `Lines 1 to ${lineOffset} of this unit are front matter. Read from line ${lineOffset + 1}.`,
    )
  }
  if (startLine > totalLines && lines.length > 0) {
    throw new McpToolError(
      "invalid_argument",
      `startLine ${startLine} is after the last line (${totalLines}).`,
    )
  }
  const first = Math.max(startLine, lineOffset + 1)
  // The front matter comes once: with the page that starts at the body.
  const header = frontMatter && first === lineOffset + 1 ? { frontMatter } : {}
  const page = fitPage(lines, {
    offset: first - lineOffset - 1,
    limit: Math.max(0, last - first + 1),
    maxTokens: 6_000,
    result: (fitted) => {
      const end = first + fitted.length - 1
      return {
        ref: formatRef(ref),
        served,
        ...header,
        content: fitted.join("\n"),
        startLine: first,
        endLine: end,
        totalLines,
        nextStartLine: end < last ? end + 1 : null,
        truncated: false,
      }
    },
  })
  const end = first + page.page.length - 1
  return {
    ref: formatRef(ref),
    served,
    ...header,
    content: page.page.join("\n"),
    startLine: first,
    endLine: end,
    totalLines,
    nextStartLine: end < last ? end + 1 : null,
    truncated: page.cut,
  }
}

export const readFileTool = defineMcpReadTool({
  name: "read_file",
  title: "Read file",
  description: [
    "Read a knowledge unit or a linked repository file by ref, with a line range.",
    "A unit ref is its path (knowledge/services/api.md) and needs workspace. A repository file ref is <handle>:<path> (example/api:src/index.ts); workspace is optional for it.",
    "Use refs from search_knowledge, search_code, find_symbol, get_related, or list_files.",
    "Line numbers are file lines. A unit gives its front matter (kind, title, claims) in frontMatter, not in content. A long file comes in pages: send nextStartLine as startLine for the next page.",
    "Do not read the repository you have open locally: pass it in excludeRepositories.",
  ].join(" "),
  org: "required",
  inputShape: readFileInputShape,
  outputSchema: readFileOutputSchema,
  run: (input, { org }) => readFileByRef(org, input),
})
