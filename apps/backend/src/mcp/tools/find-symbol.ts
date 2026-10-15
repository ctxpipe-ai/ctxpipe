import { z } from "zod"
import {
  loadOrgRepositoryHandles,
  resolveCallWorkspace,
} from "../framework/call-workspace.js"
import { decodeCursor } from "../framework/cursor.js"
import {
  findSymbolAcrossRepositories,
  resolveCodeScope,
} from "../framework/org-code.js"
import { parseRef } from "../framework/refs.js"
import {
  excludeRepositoriesSchema,
  servedSchema,
  skippedSchema,
  workspaceArgument,
} from "../framework/schemas.js"
import { defineMcpReadTool } from "../framework/tool-registry.js"
import { codeFileRef, mapCodeItems, pageCodeResults } from "./code-results.js"

export const findSymbolTool = defineMcpReadTool({
  name: "find_symbol",
  title: "Find symbol",
  description:
    "Exclude your current repository. Find SCIP symbol definitions, references, callers, or callees on the default branch. Send independent calls in parallel. Use returned refs with read_file in a Workspace that links the repository. Narrow the scope when repositories are skipped.",
  org: "required",
  inputShape: {
    workspace: workspaceArgument
      .optional()
      .describe(
        "Workspace slug from list_workspaces. Limits the lookup to the repositories this Workspace links. Omit it to use all linked repositories of the org.",
      ),
    repositories: z
      .array(z.string().min(1).max(512))
      .max(100)
      .optional()
      .describe(
        "Repository handles or git URLs to search. Omit it to use every linked repository in scope.",
      ),
    excludeRepositories: excludeRepositoriesSchema,
    symbol: z
      .string()
      .min(1)
      .max(4000)
      .describe("Symbol name or SCIP symbol id, for example PaymentService."),
    relation: z
      .enum(["definition", "references", "callers", "callees"])
      .describe(
        "definition: where the symbol is defined. references: where it is used. callers: who calls it. callees: what it calls.",
      ),
    filePath: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "File of the symbol, to tell same names apart: a ref from search_code (owner/name:src/x.ts), or a path in the repository.",
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
        ref: z.string().optional(),
        startLine: z.number().optional(),
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
    const workspace = input.workspace
      ? await resolveCallWorkspace(org, input.workspace)
      : undefined
    // A ref from search_code names the file and, without `repositories`, the
    // repository too.
    let filePath = input.filePath
    let repositories = input.repositories
    if (filePath) {
      const ref = parseRef(filePath, await loadOrgRepositoryHandles(org))
      filePath = ref.path
      if (ref.kind === "file" && !repositories?.length) {
        repositories = [ref.handle]
      }
    }
    const scope = await resolveCodeScope(org, {
      repositories,
      excludeRepositories: input.excludeRepositories,
      workspaceId: workspace?.id,
    })
    const { cursor, ...parameters } = input
    const binding = {
      orgId: org.id,
      workspaceId: workspace?.id ?? null,
      scope: JSON.stringify(["find_symbol", parameters]),
      sha: JSON.stringify(scope.repositories.map((r) => [r.handle, r.sha])),
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
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
        filePath,
      },
      { limit: input.limit, offset },
    )
    const mapped = mapCodeItems(answer.results, (item) => {
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
          startLine: match.call_range.start_line + 1,
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
              startLine: match.range.start_line + 1,
              endLine: match.range.end_line + 1,
            }
          : {}),
        served: { branch: source.branch, sha: source.sha },
      }
    })
    return pageCodeResults({
      answer,
      mapped,
      offset,
      binding,
      maxTokens: 4_000,
    })
  },
})
