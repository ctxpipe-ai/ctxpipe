import { z } from "zod"
import { truncateText } from "../framework/budget.js"
import { resolveCallWorkspace } from "../framework/call-workspace.js"
import { decodeCursor } from "../framework/cursor.js"
import {
  resolveCodeScope,
  searchCodeText,
  structuralSearchAcrossRepositories,
} from "../framework/org-code.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  skippedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"
import { codeFileRef, mapCodeItems, pageCodeResults } from "./code-results.js"

const structuralMatchSchema = z.object({
  file: z.string(),
  text: z.string(),
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative() }),
    end: z.object({ line: z.number().int().nonnegative() }).optional(),
  }),
})
const textMatchSchema = z.object({
  path: z.string(),
  line: z.number().nullable(),
  snippet: z.string(),
})

export const searchCodeTool = defineMcpReadTool({
  name: "search_code",
  title: "Search code",
  description:
    "Exclude your current repository. Search the default branches of linked repositories. Send independent calls in parallel. Use returned refs with read_file. Send cursor for the next page.",
  org: "required",
  inputShape: {
    workspace: workspaceArgument
      .optional()
      .describe(
        "Workspace slug from list_workspaces. Limits the search to the repositories this Workspace links. Omit it to search all linked repositories of the org.",
      ),
    repositories: z
      .array(z.string().min(1).max(512))
      .max(100)
      .optional()
      .describe(
        "Repository handles or git URLs to search. Omit it to search every linked repository in scope.",
      ),
    excludeRepositories: excludeRepositoriesSchema,
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Text to find (literal), an RE2 expression (regex), or an ast-grep pattern (structural).",
      ),
    mode: z
      .enum(["literal", "regex", "structural"])
      .describe(
        "literal: exact text. regex: RE2. structural: ast-grep pattern, with language.",
      ),
    language: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Required for structural search: an ast-grep language, such as typescript.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Results in one page. Default 20."),
    cursor: z
      .string()
      .max(2_048)
      .optional()
      .describe("The cursor of the last result, for the next page."),
  },
  outputSchema: z.object({
    results: z.array(
      z.object({
        repository: z.string(),
        ref: z.string(),
        startLine: z.number().nullable(),
        endLine: z.number().nullable(),
        snippet: z.string(),
        served: servedSchema,
      }),
    ),
    excluded: z.array(z.string()),
    skipped: z.array(skippedSchema),
    truncated: z.boolean(),
    cursor: z.string().optional(),
    hint: z.string().optional(),
  }),
  async run(input, { org }) {
    if (input.mode === "structural" && !input.language) {
      throw new McpToolError(
        "invalid_argument",
        "Structural search requires language.",
      )
    }
    const workspace = input.workspace
      ? await resolveCallWorkspace(org, input.workspace)
      : undefined
    const scope = await resolveCodeScope(org, {
      ...input,
      workspaceId: workspace?.id,
    })
    const { cursor, ...parameters } = input
    const binding = {
      orgId: org.id,
      workspaceId: workspace?.id ?? null,
      scope: JSON.stringify(["search_code", parameters]),
      sha: JSON.stringify(scope.repositories.map((r) => [r.handle, r.sha])),
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const answer =
      input.mode === "structural"
        ? await structuralSearchAcrossRepositories(
            org,
            scope,
            { pattern: input.query, lang: input.language },
            { limit: input.limit, offset },
          )
        : await searchCodeText(org, scope, {
            query: input.query,
            mode: input.mode,
            limit: input.limit,
            offset,
          })
    let cutSnippet = false
    const found: Array<{ repository: string }> = answer.results
    const mapped = mapCodeItems(found, (item) => {
      const { repository } = item
      const hit =
        input.mode === "structural"
          ? (() => {
              const match = structuralMatchSchema.parse(item)
              const startLine = match.range.start.line + 1
              return {
                path: match.file,
                startLine,
                endLine: (match.range.end?.line ?? match.range.start.line) + 1,
                snippet: match.text,
              }
            })()
          : (() => {
              const match = textMatchSchema.parse(item)
              return {
                path: match.path,
                startLine: match.line,
                endLine: match.line,
                snippet: match.snippet,
              }
            })()
      const source = scope.repositories.find(
        (entry) => entry.handle === repository,
      )
      if (!source) throw new Error("Search returned an unknown repository")
      const snippet = truncateText(hit.snippet, 4_000)
      if (snippet !== hit.snippet) cutSnippet = true
      return {
        repository,
        ref: codeFileRef(source, hit.path),
        startLine: hit.startLine,
        endLine: hit.endLine,
        snippet,
        served: { branch: source.branch, sha: source.sha },
      }
    })
    return pageCodeResults({
      answer,
      mapped,
      offset,
      binding,
      maxTokens: 4_000,
      cutSnippet,
    })
  },
})
