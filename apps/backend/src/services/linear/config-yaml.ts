import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const LinearConfigScopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  key: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  teamId: z.string().min(1).nullable().optional(),
  teamKey: z.string().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
})

const LinearConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  source: z.literal("linear").default("linear"),
  workspace: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  scope: z
    .object({
      teams: z.array(LinearConfigScopeSchema).default([]),
      projects: z.array(LinearConfigScopeSchema).default([]),
      documents: z.array(LinearConfigScopeSchema).default([]),
      initiatives: z.array(LinearConfigScopeSchema).default([]),
    })
    .default({
      teams: [],
      projects: [],
      documents: [],
      initiatives: [],
    }),
  policy: z
    .object({
      customerRequests: z.enum(["exclude", "limited"]).default("limited"),
      githubLinks: z.literal("references_only").default("references_only"),
      attachmentBinaries: z.literal(false).default(false),
    })
    .default({
      customerRequests: "limited",
      githubLinks: "references_only",
      attachmentBinaries: false,
    }),
})

export type ParsedLinearRepoConfig = {
  workspaceId: string
  workspaceName: string
  customerRequests: "exclude" | "limited"
  scopes: Array<{
    externalId: string
    type: "team" | "project" | "document" | "initiative"
    title: string
    url: string | null
    parentExternalId: string | null
    teamId: string | null
    teamKey: string | null
  }>
}

type LinearConfigScopeInput = ParsedLinearRepoConfig["scopes"][number]

function sortScopes(
  scopes: LinearConfigScopeInput[],
): LinearConfigScopeInput[] {
  return [...scopes].sort((left, right) =>
    `${left.type}:${left.externalId}`.localeCompare(
      `${right.type}:${right.externalId}`,
    ),
  )
}

export function linearScopesEqual(
  left: LinearConfigScopeInput[],
  right: LinearConfigScopeInput[],
): boolean {
  const comparable = (scopes: LinearConfigScopeInput[]) =>
    sortScopes(scopes).map((scope) => [
      scope.externalId,
      scope.type,
      scope.title,
      scope.url,
      scope.parentExternalId,
      scope.teamId,
      scope.teamKey,
    ])
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

export function parseLinearConfigYamlContent(
  raw: string | undefined,
): ParsedLinearRepoConfig | undefined {
  if (raw == null || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  const decoded = LinearConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined

  const scopes: ParsedLinearRepoConfig["scopes"] = []
  for (const [pluralType, entries] of Object.entries(decoded.data.scope)) {
    const type = pluralType.slice(0, -1) as LinearConfigScopeInput["type"]
    scopes.push(
      ...entries.map((entry) => ({
        externalId: entry.id,
        type,
        title: entry.name,
        url: entry.url ?? null,
        parentExternalId: entry.parentId ?? null,
        teamId: entry.teamId ?? (type === "team" ? entry.id : null),
        teamKey:
          entry.teamKey ?? (type === "team" ? (entry.key ?? null) : null),
      })),
    )
  }
  const scopeKeys = scopes.map((scope) => `${scope.type}:${scope.externalId}`)
  if (new Set(scopeKeys).size !== scopeKeys.length) return undefined

  return {
    workspaceId: decoded.data.workspace.id,
    workspaceName: decoded.data.workspace.name,
    customerRequests: decoded.data.policy.customerRequests,
    scopes: sortScopes(scopes),
  }
}

export function renderLinearConfigYaml(input: {
  workspaceId: string
  workspaceName: string
  scopes: LinearConfigScopeInput[]
  customerRequests?: "exclude" | "limited"
}): string {
  const grouped = {
    teams: [] as Array<Record<string, string | null>>,
    projects: [] as Array<Record<string, string | null>>,
    documents: [] as Array<Record<string, string | null>>,
    initiatives: [] as Array<Record<string, string | null>>,
  }
  for (const scope of sortScopes(input.scopes)) {
    grouped[`${scope.type}s`].push({
      id: scope.externalId,
      name: scope.title,
      ...(scope.type === "team" ? { key: scope.teamKey } : {}),
      ...(scope.parentExternalId ? { parentId: scope.parentExternalId } : {}),
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
      ...(scope.teamKey ? { teamKey: scope.teamKey } : {}),
      ...(scope.url ? { url: scope.url } : {}),
    })
  }

  return stringify({
    version: 1,
    source: "linear",
    workspace: {
      id: input.workspaceId,
      name: input.workspaceName,
    },
    scope: grouped,
    policy: {
      customerRequests: input.customerRequests ?? "limited",
      githubLinks: "references_only",
      attachmentBinaries: false,
    },
  })
}

export function hasLinearConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const current = parseLinearConfigYamlContent(input.current)
  const next = parseLinearConfigYamlContent(input.next)
  return current && next
    ? JSON.stringify(current) !== JSON.stringify(next)
    : (input.current ?? "").trim() !== input.next.trim()
}

export function getLinearConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Linear sync configuration",
    body: [
      "This PR updates `linear/config.yaml` from the Linear connector settings.",
      "",
      "GitHub pull requests and commits remain references only; their bodies, diffs, reviews, and CI data are not mirrored from Linear.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(linear): update sync config.yaml",
  }
}
