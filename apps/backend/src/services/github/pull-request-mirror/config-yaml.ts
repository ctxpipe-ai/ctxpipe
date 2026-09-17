import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const GithubPrConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  source: z.literal("github").default("github"),
  pullRequests: z
    .object({
      repositories: z.array(z.string().min(1)).default([]),
      states: z.array(z.enum(["open", "merged"])).default(["merged"]),
      includeDrafts: z.boolean().default(false),
      updatedSince: z.string().min(1).optional(),
      maxPullRequestsPerRepository: z.number().int().positive().default(100),
    })
    .default({
      repositories: [],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 100,
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
      maxPullRequestsPerRepository: 100,
    },
  })
}

export function getGithubPrConfigPullRequestPayload(input: {
  repositoryCount: number
}): { title: string; body: string } {
  return {
    title: "Configure ctx| GitHub pull request mirror",
    body: [
      "This pull request adds `github/config.yaml`, which lists the source",
      "repositories whose **merged** pull requests ctx| should copy into this",
      "context repository (conversation, reviews, and changed paths — not diffs).",
      "",
      `Default scope: ${input.repositoryCount} ingested repositor${
        input.repositoryCount === 1 ? "y" : "ies"
      }.`,
      "",
      "After merge, ctx| writes one Markdown file per pull request under",
      "`github/pulls/` and records added / modified / removed / renamed edges",
      "in the knowledge graph.",
    ].join("\n"),
  }
}
