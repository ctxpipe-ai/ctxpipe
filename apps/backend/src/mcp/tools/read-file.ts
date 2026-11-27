import { z } from "zod"

import { fetchCheckoutFileBytes } from "../../domain/codeIngestion/codesearchClient.js"
import type { HydrateClaim } from "../../domain/workspaces/hydrate.js"
import { servedKnowledgeHead } from "../../knowledge-reader/knowledge-reader.js"
import { readPlaneUnit } from "../../knowledge-reader/plane-files.js"
import type { KnowledgeHead } from "../../models/knowledge-state.js"
import { log } from "../../observability/logger.js"
import { fitPage, measureResult, truncateText } from "../framework/budget.js"
import {
  type CallWorkspace,
  loadOrgRepositoryHandles,
  loadWorkspaceHandles,
  requireServed,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import {
  type KnowledgeNotice,
  legacyKnowledgeNotices,
  withNotices,
} from "../framework/legacy-knowledge.js"
import {
  type CodeRepository,
  requireLinkedRepository,
} from "../framework/org-code.js"
import { formatRef, parseRef } from "../framework/refs.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  branchArgument,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import type { CallOrg } from "../framework/tool-org.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"

/** Claims that the front matter of one read shows. */
const MAX_FRONT_MATTER_CLAIMS = 20

/** Characters of a front matter title, claim target, or source. */
const MAX_FRONT_MATTER_TEXT = 200

/** Tokens that the front matter may take; a larger one is left out. */
const MAX_FRONT_MATTER_TOKENS = 1_500

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

/** The front matter of a unit, cut to the limits of one read. */
function frontMatterOf(unit: {
  kind: string | null
  title: string | null
  source: string | null
  updatedAt: Date
  claims: readonly HydrateClaim[]
}): FrontMatter {
  const claims: NonNullable<FrontMatter["claims"]> = unit.claims
    .slice(0, MAX_FRONT_MATTER_CLAIMS)
    .map((claim) => ({
      to: truncateText(claim.to, MAX_FRONT_MATTER_TEXT),
      ...(claim.predicate !== null ? { predicate: claim.predicate } : {}),
      ...(claim.confidence !== null ? { confidence: claim.confidence } : {}),
      ...(claim.validFrom !== null ? { validFrom: claim.validFrom } : {}),
      ...(claim.validTo !== null ? { validTo: claim.validTo } : {}),
      ...(claim.source !== null
        ? { source: truncateText(claim.source, MAX_FRONT_MATTER_TEXT) }
        : {}),
    }))
  return {
    ...(unit.kind ? { kind: unit.kind } : {}),
    ...(unit.title
      ? { title: truncateText(unit.title, MAX_FRONT_MATTER_TEXT) }
      : {}),
    source: truncateText(unit.source ?? "authored", MAX_FRONT_MATTER_TEXT),
    updatedAt: unit.updatedAt.toISOString(),
    ...(claims.length ? { claims } : {}),
    ...(unit.claims.length > claims.length
      ? { moreClaims: unit.claims.length - claims.length }
      : {}),
  }
}

/**
 * A unit of the Workspace Git at the SHA that the knowledge plane serves.
 * The text is the body without front matter, and `lineOffset` is the
 * count of its lines of front matter. The `updatedAt` of the front matter
 * comes from the plane (`readPlaneUnit`).
 */
async function readPlaneUnitFile(
  org: CallOrg,
  workspace: CallWorkspace,
  head: KnowledgeHead,
  path: string,
): Promise<{
  text: string
  lineOffset: number
  sha: string
  frontMatter: FrontMatter
} | null> {
  const read = await readPlaneUnit({
    orgId: org.id,
    workspaceId: workspace.id,
    head,
    path,
  })
  if (!read) return null
  const { unit, updatedAt, sha } = read
  return {
    text: unit.body,
    lineOffset: (unit.bodyStartLine ?? 1) - 1,
    sha,
    frontMatter: frontMatterOf({
      kind: unit.kind ?? null,
      title: unit.title,
      source: unit.source,
      updatedAt,
      claims: unit.claims,
    }),
  }
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
  branch: branchArgument.describe(
    "For a unit path: a branch of the Workspace repository. Default: the default branch. A branch can be read after a commit on it is projected.",
  ),
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
  frontMatterOmitted: z
    .boolean()
    .optional()
    .describe(
      "The front matter is too large to show here. Use get_related for the claims of this unit.",
    ),
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

type ReadFileInput = z.infer<z.ZodObject<typeof readFileInputShape>>
type ReadFileOutput = z.infer<typeof readFileOutputSchema>

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
  // The main-era knowledge that the plane does not serve (CTX-1715).
  let notices: KnowledgeNotice[] = []
  if (ref.kind === "unit") {
    if (!workspace) throw new Error("A unit ref has a Workspace")
    const workspaceServed = requireServed(workspace)
    const head = await servedKnowledgeHead(org.id, workspace.id, input.branch)
    notices = legacyKnowledgeNotices([workspace])
    const unit = await readPlaneUnitFile(org, workspace, head, ref.path)
    text = unit?.text ?? null
    frontMatter = unit?.frontMatter
    lineOffset = unit?.lineOffset ?? 0
    served = {
      branch: input.branch ?? workspaceServed.branch,
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
    throw withNotices(
      new McpToolError(
        "unknown_ref",
        `No file "${input.ref.slice(0, 200)}". Use a ref from a result or from list_files.`,
      ),
      notices,
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
  const wantsFrontMatter = frontMatter && first === lineOffset + 1
  const fitsBudget =
    frontMatter !== undefined &&
    measureResult({ frontMatter }).tokens <= MAX_FRONT_MATTER_TOKENS
  const header = !wantsFrontMatter
    ? {}
    : fitsBudget
      ? { frontMatter }
      : { frontMatterOmitted: true }
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
  // The next line follows the lines that the page took or left out, so the
  // cursor always moves forward.
  const nextLine =
    page.nextOffset === null ? null : page.nextOffset + lineOffset + 1
  return {
    ref: formatRef(ref),
    served,
    ...header,
    content: page.page.join("\n"),
    startLine: first,
    endLine: end,
    totalLines,
    nextStartLine: nextLine !== null && nextLine <= last ? nextLine : null,
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
  // One file for each call; `ctxpipe.mcp.result.bytes` gives its size.
  describeResult: () => ({ count: 1 }),
  run: (input, { org }) => readFileByRef(org, input),
})
