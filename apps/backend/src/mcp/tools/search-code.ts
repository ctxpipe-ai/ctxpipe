import { z } from "zod"

import { truncateText } from "../framework/budget.js"
import { resolveCallWorkspace } from "../framework/call-workspace.js"
import { decodeCursor } from "../framework/cursor.js"
import { languageOfPath } from "../framework/languages.js"
import {
  checkPathGlob,
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
const textFileSchema = z.object({
  path: z.string(),
  language: z.string().nullable(),
  matches: z.array(
    z.object({ line: z.number().nullable(), snippet: z.string() }),
  ),
})

/** Matches that one file shows; `matchCount` counts all of them. */
const MATCHES_PER_FILE = 3

type FileHits = {
  repository: string
  path: string
  language: string | null
  matches: Array<{
    startLine: number | null
    endLine: number | null
    snippet: string
  }>
}

export const searchCodeTool = defineMcpReadTool({
  name: "search_code",
  title: "Search code",
  description:
    "Exclude your current repository. Search the default branches of linked repositories. Results come per file, with the match count, the language, and the first matches. Send independent calls in parallel. Use returned refs with read_file. Send cursor for the next page.",
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
    pathGlob: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "Only files whose path matches this gitignore-style glob, such as *.ts or src/**/*.ts. A glob with no / matches at any depth; a glob with a / starts at the repository root. * and ? stay in one folder; ** crosses folders. No ! negation. Same in every mode.",
      ),
    caseSensitive: z
      .boolean()
      .optional()
      .describe(
        "literal and regex: true matches case exactly, false ignores case. Default: exact only when the query has an upper-case letter. Structural search always matches case.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe(
        "Files in one page (structural: matches). Default 10, at most 30.",
      ),
    cursor: z
      .string()
      .max(2_048)
      .optional()
      .describe("The cursor of the last result, for the next page."),
  },
  outputSchema: z.object({
    files: z.array(
      z.object({
        repository: z.string(),
        ref: z.string(),
        language: z.string().nullable(),
        matchCount: z.number().int(),
        matches: z.array(
          z.object({
            startLine: z.number().nullable(),
            endLine: z.number().nullable(),
            snippet: z.string(),
          }),
        ),
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
    // Text search gives one item for each file. Structural search gives one
    // item for each match; consecutive matches of one file share one item.
    const answer =
      input.mode === "structural"
        ? await structuralSearchAcrossRepositories(
            org,
            scope,
            {
              pattern: input.query,
              lang: input.language,
              ...(input.pathGlob
                ? { globs: [checkPathGlob(input.pathGlob)] }
                : {}),
            },
            { limit: input.limit, offset },
          )
        : await searchCodeText(org, scope, {
            query: input.query,
            mode: input.mode,
            pathGlob: input.pathGlob,
            caseSensitive: input.caseSensitive,
            limit: input.limit,
            offset,
          })
    const found: Array<{ repository: string }> = answer.results
    const parsed = mapCodeItems(found, (item): FileHits => {
      if (input.mode !== "structural") {
        const file = textFileSchema.parse(item)
        return {
          repository: item.repository,
          path: file.path,
          language: file.language,
          matches: file.matches.map((match) => ({
            startLine: match.line,
            endLine: match.line,
            snippet: match.snippet,
          })),
        }
      }
      const match = structuralMatchSchema.parse(item)
      return {
        repository: item.repository,
        path: match.file,
        language: languageOfPath(match.file),
        matches: [
          {
            startLine: match.range.start.line + 1,
            endLine: (match.range.end?.line ?? match.range.start.line) + 1,
            snippet: match.text,
          },
        ],
      }
    })
    const grouped: typeof parsed = { ...parsed, results: [], indexes: [] }
    parsed.results.forEach((hit, at) => {
      const index = parsed.indexes[at] as number
      const last = grouped.results.at(-1)
      if (
        last &&
        last.repository === hit.repository &&
        last.path === hit.path &&
        grouped.indexes.at(-1) === index - 1
      ) {
        last.matches.push(...hit.matches)
        grouped.indexes[grouped.indexes.length - 1] = index
      } else {
        grouped.results.push({ ...hit, matches: [...hit.matches] })
        grouped.indexes.push(index)
      }
    })
    let cutSnippet = false
    const mapped = mapCodeItems(
      grouped.results.map((hit, at) => ({ ...hit, at })),
      (hit) => {
        const source = scope.repositories.find(
          (entry) => entry.handle === hit.repository,
        )
        if (!source) throw new Error("Search returned an unknown repository")
        const matches = hit.matches.slice(0, MATCHES_PER_FILE).map((match) => {
          const snippet = truncateText(match.snippet, 1_000)
          if (snippet !== match.snippet) cutSnippet = true
          return { ...match, snippet }
        })
        return {
          repository: hit.repository,
          ref: codeFileRef(source, hit.path),
          language: hit.language,
          matchCount: hit.matches.length,
          matches,
          served: { branch: source.branch, sha: source.sha },
        }
      },
    )
    mapped.indexes = mapped.indexes.map((at) => grouped.indexes[at] as number)
    mapped.failed.push(...grouped.failed)
    const { results, ...page } = pageCodeResults({
      answer,
      mapped,
      offset,
      binding,
      // ADR-051 deviation: the design allows 5,000 tokens; 4,000 keeps the
      // agent context smaller.
      maxTokens: 4_000,
      cutSnippet,
    })
    return { files: results, ...page }
  },
})
