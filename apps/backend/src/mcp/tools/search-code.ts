import { z } from "zod"
import { resolveCallWorkspace } from "../framework/call-workspace.js"
import {
  resolveCodeScope,
  searchCodeText,
  structuralSearchAcrossRepositories,
} from "../framework/org-code.js"
import { McpToolError } from "../framework/tool-errors.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"
import { boundCodeResults, codeFileRef } from "./code-results.js"

export const searchCodeTool = defineMcpReadTool({
  name: "search_code",
  title: "Search code",
  description:
    "Exclude your current repository. Search the default branches of linked repositories. Send independent calls in parallel. Use returned refs with read_file in a Workspace that links the repository.",
  org: "required",
  inputShape: {
    workspace: z.string().min(1).max(64).optional(),
    repositories: z.array(z.string().min(1).max(2048)).max(100).optional(),
    excludeRepositories: z.array(z.string().min(1).max(2048)).max(100),
    query: z.string().min(1).max(4000),
    mode: z.enum(["literal", "regex", "structural"]),
    language: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Required for structural search: an ast-grep language, such as typescript.",
      ),
    limit: z.number().int().min(1).max(100).default(20),
  },
  outputSchema: z.object({
    results: z.array(
      z.object({
        repository: z.string(),
        ref: z.string(),
        line: z.number().nullable(),
        snippet: z.string(),
        served: z.object({ branch: z.string(), sha: z.string().nullable() }),
      }),
    ),
    excluded: z.array(z.string()),
    skipped: z.array(
      z.object({
        repository: z.string(),
        reason: z.enum(["not_indexed", "failed", "over_limit"]),
      }),
    ),
    truncated: z.boolean(),
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
    const answer =
      input.mode === "structural"
        ? await structuralSearchAcrossRepositories(
            org,
            scope,
            { pattern: input.query, lang: input.language },
            { limit: input.limit, maxTokens: 5000 },
          )
        : await searchCodeText(org, scope, {
            ...input,
            mode: input.mode,
            maxTokens: 5000,
          })
    return boundCodeResults(
      {
        results: answer.results.map((item) => {
          const { repository } = item
          const match =
            input.mode === "structural"
              ? z
                  .object({
                    file: z.string(),
                    text: z.string(),
                    range: z.object({
                      start: z.object({ line: z.number().int().nonnegative() }),
                    }),
                  })
                  .parse(item)
              : null
          const { path, line, snippet } = match
            ? {
                path: match.file,
                line: match.range.start.line + 1,
                snippet: match.text,
              }
            : z
                .object({
                  path: z.string(),
                  line: z.number().nullable(),
                  snippet: z.string(),
                })
                .parse(item)
          const source = scope.repositories.find(
            (entry) => entry.handle === repository,
          )
          if (!source) throw new Error("Search returned an unknown repository")
          return {
            repository,
            ref: codeFileRef(source, path),
            line,
            snippet,
            served: { branch: source.branch, sha: source.sha },
          }
        }),
        excluded: answer.excluded,
        skipped: answer.skipped,
        truncated: answer.truncated,
        ...(answer.hint ? { hint: answer.hint } : {}),
      },
      5000,
    )
  },
})
