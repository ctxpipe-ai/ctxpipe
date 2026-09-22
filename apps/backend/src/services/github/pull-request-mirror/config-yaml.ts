import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const DEFAULT_MAX_PULL_REQUESTS_PER_REPOSITORY = 200

const GithubPrConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  source: z.literal("github").default("github"),
  pullRequests: z
    .object({
      repositories: z.array(z.string().min(1)).default([]),
      states: z.array(z.enum(["open", "merged"])).default(["merged"]),
      includeDrafts: z.boolean().default(false),
      updatedSince: z.string().min(1).optional(),
      maxPullRequestsPerRepository: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_MAX_PULL_REQUESTS_PER_REPOSITORY),
    })
    .default({
      repositories: [],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: DEFAULT_MAX_PULL_REQUESTS_PER_REPOSITORY,
    }),
})

export type GithubPrMirrorRepoConfig = {
  repositories: string[]
  states: Array<"open" | "merged">
  includeDrafts: boolean
  updatedSince?: string
  maxPullRequestsPerRepository: number
}

export function parseGithubPrConfigYamlContent(
  raw: string | undefined | null,
): GithubPrMirrorRepoConfig | undefined {
  if (raw == null || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  const result = GithubPrConfigFileSchema.safeParse(parsed)
  if (!result.success) return undefined
  const pullRequests = result.data.pullRequests
  return {
    repositories: [...new Set(pullRequests.repositories)].sort((a, b) =>
      a.localeCompare(b),
    ),
    states: [...new Set(pullRequests.states)],
    includeDrafts: pullRequests.includeDrafts,
    updatedSince: pullRequests.updatedSince,
    maxPullRequestsPerRepository: pullRequests.maxPullRequestsPerRepository,
  }
}

export function renderGithubPrConfigYaml(input: {
  repositories: string[]
}): string {
  return stringify({
    version: 1,
    source: "github",
    pullRequests: {
      repositories: [...new Set(input.repositories)].sort((a, b) =>
        a.localeCompare(b),
      ),
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: DEFAULT_MAX_PULL_REQUESTS_PER_REPOSITORY,
    },
  })
}
