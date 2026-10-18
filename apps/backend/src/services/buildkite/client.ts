import { z } from "zod"
import type {
  BuildkiteBuildForMirror,
  BuildkitePipelineForMirror,
} from "./converter.js"

const BUILDKITE_API = "https://api.buildkite.com/v2"

/** The REST scopes that the API access token must have (ADR-054). */
export const BUILDKITE_REQUIRED_SCOPES = [
  "read_pipelines",
  "read_builds",
] as const

/**
 * The read scopes that a token may have. The token gets no other scope, so a
 * leaked token cannot change Buildkite, and cannot read build logs or job
 * environments.
 */
const BUILDKITE_ALLOWED_SCOPES: ReadonlySet<string> = new Set([
  ...BUILDKITE_REQUIRED_SCOPES,
  "read_organizations",
  "read_user",
  "read_teams",
  "read_agents",
  "read_clusters",
  "read_artifacts",
  "read_suites",
])

/** The number of finished builds that a source keeps for each pipeline. */
export const BUILDKITE_BUILDS_PER_PIPELINE = 25

/** The pipeline picker reads at most this many pages of 100 pipelines. */
const BUILDKITE_MAX_PIPELINE_PAGES = 10

/** Buildkite does not accept the API access token any more (401). */
export class BuildkiteUnauthorizedError extends Error {
  constructor(message = "Buildkite does not accept the API access token") {
    super(message)
    this.name = "BuildkiteUnauthorizedError"
  }
}

/**
 * One GET. On a rate limit, wait for the reset that Buildkite gives and send
 * the same request again, so the caller's step still succeeds.
 */
async function buildkiteGet(input: {
  apiToken: string
  path: string
  search?: Record<string, string>
}): Promise<Response> {
  const url = new URL(`${BUILDKITE_API}${input.path}`)
  for (const [name, value] of Object.entries(input.search ?? {}))
    url.searchParams.set(name, value)
  for (let attempt = 0; ; attempt += 1) {
    // No redirect: the token and the reads stay on the Buildkite API host.
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) throw new BuildkiteUnauthorizedError()
    if (response.status !== 429 || attempt >= 4) return response
    const reset = Number(response.headers.get("ratelimit-reset"))
    const delayMs =
      Number.isFinite(reset) && reset > 0
        ? Math.min(reset, 60) * 1000
        : 500 * 2 ** attempt
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  if (!response.ok)
    throw new Error(`Buildkite ${what} failed (${response.status})`)
  return schema.parse(await response.json())
}

const nullableString = z.string().nullish().default(null)

const pipelineSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  web_url: z.string(),
  repository: nullableString,
  default_branch: nullableString,
})

// Only the fields that the mirror renders. Zod drops the rest, so the build
// env, meta-data, and job commands never reach a file.
const buildSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  web_url: z.string(),
  state: z.string(),
  branch: nullableString,
  commit: nullableString,
  created_at: nullableString,
  finished_at: nullableString,
  creator: z.object({ name: nullableString }).nullish(),
  pull_request: z.object({ id: z.string() }).nullish(),
  jobs: z
    .array(
      z.object({
        name: nullableString,
        state: nullableString,
        soft_failed: z.boolean().nullish(),
        web_url: nullableString,
      }),
    )
    .default([]),
})

function toPipeline(
  pipeline: z.infer<typeof pipelineSchema>,
): BuildkitePipelineForMirror {
  return {
    id: pipeline.id,
    slug: pipeline.slug,
    name: pipeline.name,
    url: pipeline.web_url,
    repository: pipeline.repository,
    defaultBranch: pipeline.default_branch,
  }
}

function toBuild(build: z.infer<typeof buildSchema>): BuildkiteBuildForMirror {
  return {
    id: build.id,
    number: build.number,
    url: build.web_url,
    state: build.state,
    branch: build.branch,
    commit: build.commit,
    createdAt: build.created_at,
    finishedAt: build.finished_at,
    creatorName: build.creator?.name ?? null,
    pullRequestNumber: build.pull_request?.id ?? null,
    jobs: build.jobs.map((job) => ({
      name: job.name?.trim() || "Unnamed step",
      state: job.state ?? "unknown",
      softFailed: job.soft_failed ?? false,
      url: job.web_url,
    })),
  }
}

/**
 * Check that the token is valid, has the read scopes, and can list the
 * pipelines of the organization. Gives the reason to show the admin.
 */
export async function verifyBuildkiteAccess(input: {
  apiToken: string
  organizationSlug: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let token: { scopes: string[] }
  try {
    token = await readJson(
      await buildkiteGet({ apiToken: input.apiToken, path: "/access-token" }),
      z.object({ scopes: z.array(z.string()) }),
      "token check",
    )
  } catch (error) {
    if (error instanceof BuildkiteUnauthorizedError)
      return {
        ok: false,
        error: "Buildkite does not accept this API access token.",
      }
    throw error
  }
  const writeScopes = token.scopes.filter((scope) => scope.startsWith("write_"))
  if (writeScopes.length)
    return {
      ok: false,
      error: `Remove the write scopes from the token: ${writeScopes.join(", ")}. The connector only reads.`,
    }
  const extraScopes = token.scopes.filter(
    (scope) => !BUILDKITE_ALLOWED_SCOPES.has(scope),
  )
  if (extraScopes.length)
    return {
      ok: false,
      error: `Remove these scopes from the token: ${extraScopes.join(", ")}. Use only ${BUILDKITE_REQUIRED_SCOPES.join(" and ")}.`,
    }
  const missing = BUILDKITE_REQUIRED_SCOPES.filter(
    (scope) => !token.scopes.includes(scope),
  )
  if (missing.length)
    return {
      ok: false,
      error: `Give the token these scopes: ${missing.join(", ")}.`,
    }
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines`,
    search: { per_page: "1" },
  })
  if (response.status === 403 || response.status === 404)
    return {
      ok: false,
      error: `The token cannot read the Buildkite organization "${input.organizationSlug}". Check the slug, and the organizations of the token.`,
    }
  if (!response.ok)
    throw new Error(`Buildkite pipeline list failed (${response.status})`)
  return { ok: true }
}

/** The pipelines of the organization, for the scope picker. */
export async function listBuildkitePipelines(input: {
  apiToken: string
  organizationSlug: string
}): Promise<{
  pipelines: Array<{ slug: string; name: string }>
  truncated: boolean
}> {
  const pipelines: Array<{ slug: string; name: string }> = []
  for (let page = 1; page <= BUILDKITE_MAX_PIPELINE_PAGES; page += 1) {
    const response = await buildkiteGet({
      apiToken: input.apiToken,
      path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines`,
      search: { page: String(page), per_page: "100" },
    })
    const items = await readJson(
      response,
      z.array(z.object({ slug: z.string(), name: z.string() })),
      "pipeline list",
    )
    pipelines.push(...items.map(({ slug, name }) => ({ slug, name })))
    if (!response.headers.get("link")?.includes('rel="next"'))
      return { pipelines, truncated: false }
  }
  return { pipelines, truncated: true }
}

/**
 * Read one pipeline. `not_found` (404) and `forbidden` (403) are permanent:
 * the pipeline is gone, or the token cannot read it. Other failures throw,
 * so a caller can retry them.
 */
export async function getBuildkitePipeline(input: {
  apiToken: string
  organizationSlug: string
  pipelineSlug: string
}): Promise<BuildkitePipelineForMirror | "not_found" | "forbidden"> {
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines/${encodeURIComponent(input.pipelineSlug)}`,
  })
  if (response.status === 404) return "not_found"
  if (response.status === 403) return "forbidden"
  // The slug is a path segment of the mirror, so it is the one of the scope,
  // never the one in the answer.
  return {
    ...toPipeline(await readJson(response, pipelineSchema, "pipeline")),
    slug: input.pipelineSlug,
  }
}

/**
 * The latest finished builds of one pipeline, newest first, with their jobs.
 * One request, whatever the number of jobs.
 */
export async function listBuildkiteBuilds(input: {
  apiToken: string
  organizationSlug: string
  pipelineSlug: string
}): Promise<BuildkiteBuildForMirror[]> {
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines/${encodeURIComponent(input.pipelineSlug)}/builds`,
    search: {
      state: "finished",
      per_page: String(BUILDKITE_BUILDS_PER_PIPELINE),
    },
  })
  return (await readJson(response, z.array(buildSchema), "build list")).map(
    toBuild,
  )
}
