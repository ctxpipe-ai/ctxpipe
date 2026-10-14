import { z } from "zod"
import { resolveCallWorkspace } from "../framework/call-workspace.js"
import {
  findSymbolAcrossRepositories,
  resolveCodeScope,
} from "../framework/org-code.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"
import { boundCodeResults, codeFileRef } from "./code-results.js"

export const findSymbolTool = defineMcpReadTool({
  name: "find_symbol",
  title: "Find symbol",
  description:
    "Exclude your current repository. Find SCIP symbol definitions, references, callers, or callees on the default branch. Send independent calls in parallel. Use returned refs with read_file in a Workspace that links the repository. Narrow the scope when repositories are skipped.",
  org: "required",
  inputShape: {
    workspace: z.string().min(1).max(64).optional(),
    repositories: z.array(z.string().min(1).max(2048)).max(100).optional(),
    excludeRepositories: z.array(z.string().min(1).max(2048)).max(100),
    symbol: z.string().min(1).max(4000),
    relation: z.enum(["definition", "references", "callers", "callees"]),
    filePath: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  outputSchema: z.object({
    results: z.array(
      z.object({
        repository: z.string(),
        ref: z.string().optional(),
        line: z.number().optional(),
        endLine: z.number().optional(),
        symbol: z.string().optional(),
        name: z.string().optional(),
        kind: z.string().optional(),
        caller: z.string().optional(),
        callerSymbol: z.string().optional(),
        callerRef: z.string().optional(),
        callee: z.string().optional(),
        calleeSymbol: z.string().optional(),
        calleeRef: z.string().optional(),
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
    const workspace = input.workspace
      ? await resolveCallWorkspace(org, input.workspace)
      : undefined
    const scope = await resolveCodeScope(org, {
      ...input,
      workspaceId: workspace?.id,
    })
    const answer = await findSymbolAcrossRepositories(
      org,
      scope,
      {
        primitive: (
          {
            definition: "find_symbol",
            references: "find_references",
            callers: "get_callers",
            callees: "get_callees",
          } as const
        )[input.relation],
        symbol: input.symbol,
        filePath: input.filePath,
      },
      { limit: input.limit, maxTokens: 4000 },
    )
    return boundCodeResults(
      {
        results: answer.results.map((item) => {
          const source = scope.repositories.find(
            (entry) => entry.handle === item.repository,
          )
          if (!source) throw new Error("Search returned an unknown repository")
          if (input.relation === "callers" || input.relation === "callees") {
            const match = z
              .object({
                caller: z.string(),
                caller_symbol: z.string(),
                caller_file_path: z.string(),
                called: z.string(),
                called_symbol: z.string(),
                called_file_path: z.string().optional(),
                call_file_path: z.string(),
                call_range: z.object({
                  start_line: z.number().int().nonnegative(),
                  end_line: z.number().int().nonnegative(),
                }),
              })
              .parse(item)
            return {
              repository: source.handle,
              ref: codeFileRef(source, match.call_file_path),
              line: match.call_range.start_line + 1,
              endLine: match.call_range.end_line + 1,
              caller: match.caller,
              callerSymbol: match.caller_symbol,
              callerRef: codeFileRef(source, match.caller_file_path),
              callee: match.called,
              calleeSymbol: match.called_symbol,
              ...(match.called_file_path
                ? { calleeRef: codeFileRef(source, match.called_file_path) }
                : {}),
              served: { branch: source.branch, sha: source.sha },
            }
          }
          const match = z
            .object({
              symbol: z.string(),
              symbol_name: z.string(),
              kind: z.string(),
              file_path: z.string().optional(),
              range: z
                .object({
                  start_line: z.number().int().nonnegative(),
                  end_line: z.number().int().nonnegative(),
                })
                .optional(),
            })
            .parse(item)
          return {
            repository: source.handle,
            symbol: match.symbol,
            name: match.symbol_name,
            kind: match.kind,
            ...(match.file_path
              ? { ref: codeFileRef(source, match.file_path) }
              : {}),
            ...(match.range
              ? {
                  line: match.range.start_line + 1,
                  endLine: match.range.end_line + 1,
                }
              : {}),
            served: { branch: source.branch, sha: source.sha },
          }
        }),
        excluded: answer.excluded,
        skipped: answer.skipped,
        truncated: answer.truncated,
        ...(answer.hint ? { hint: answer.hint } : {}),
      },
      4000,
    )
  },
})
