import { z } from "zod"
import { readBoundedJson } from "../connectors/bounded-json.js"
import type {
  BuildkiteBuildForMirror,
  BuildkitePipelineForMirror,
} from "./converter.js"

const BUILDKITE_API = "https://api.buildkite.com/v2"
const BUILDKITE_GRAPHQL = "https://graphql.buildkite.com/v1"

/** The REST scopes that the API access token must have (ADR-054). */
export const BUILDKITE_REQUIRED_SCOPES = [
  "read_pipelines",
  "read_builds",
] as const

/** The number of finished builds that a source keeps for each pipeline. */
export const BUILDKITE_BUILDS_PER_PIPELINE = 25

/**
 * The most bytes of one Buildkite answer. A page of 25 builds with hundreds
 * of jobs each is far below it.
 */
const BUILDKITE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** The pipeline picker reads at most this many pages of 100 pipelines. */
const BUILDKITE_MAX_PIPELINE_PAGES = 10

/** Buildkite does not accept the API access token any more (401). */
export class BuildkiteUnauthorizedError extends Error {
  constructor(message = "Buildkite does not accept the API access token") {
    super(message)
    this.name = "BuildkiteUnauthorizedError"
  }
}

/** The routes that the admin calls in the browser wait at most this long. */
const BUILDKITE_INTERACTIVE_MAX_WAIT_MS = 10_000

/**
 * One GET. On a rate limit, wait for the reset that Buildkite gives and send
 * the same request again, so the caller's step still succeeds.
 */
async function buildkiteGet(input: {
  apiToken: string
  path: string
  search?: Record<string, string>
  /**
   * The most time that rate-limit waits may add up to. A browser HTTP request
   * sets it, so the admin does not wait for minutes. Sync has no limit. When
   * the next wait is over the limit, the 429 response goes to the caller.
   */
  maxWaitMs?: number
  /** The time to wait for each request. Tests set a short one. */
  timeoutMs?: number
}): Promise<Response> {
  const url = new URL(`${BUILDKITE_API}${input.path}`)
  for (const [name, value] of Object.entries(input.search ?? {}))
    url.searchParams.set(name, value)
  let waitedMs = 0
  for (let attempt = 0; ; attempt += 1) {
    // No redirect: the token and the reads stay on the Buildkite API host.
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    })
    if (response.status === 401) throw new BuildkiteUnauthorizedError()
    if (response.status !== 429 || attempt >= 4) return response
    const reset = Number(response.headers.get("ratelimit-reset"))
    const delayMs =
      Number.isFinite(reset) && reset > 0
        ? Math.min(reset, 60) * 1000
        : 500 * 2 ** attempt
    if (waitedMs + delayMs > (input.maxWaitMs ?? Number.POSITIVE_INFINITY))
      return response
    waitedMs += delayMs
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
  return schema.parse(
    await readBoundedJson(response, BUILDKITE_MAX_RESPONSE_BYTES),
  )
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
 * GraphQL access is a token setting apart from the REST scopes, and
 * `/access-token` does not always show it. With GraphQL access, the token can
 * do all that its user can do, also writes. Thus send one read query:
 * Buildkite refuses it (401 or 403) only when GraphQL access is off. Each
 * other result, also an error, gives "enabled" or "unknown", and the caller
 * refuses the token (fail closed).
 */
async function buildkiteGraphqlAccess(input: {
  apiToken: string
  timeoutMs?: number
}): Promise<"disabled" | "enabled" | "unknown"> {
  let response: Response
  try {
    // No redirect: the token stays on the Buildkite GraphQL host.
    response = await fetch(BUILDKITE_GRAPHQL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    })
  } catch {
    return "unknown"
  }
  // The body is not necessary. Do not read it.
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 401 || response.status === 403) return "disabled"
  return response.ok ? "enabled" : "unknown"
}

/**
 * Check that the token is valid, has the read scopes only, has no GraphQL
 * access, and can list the pipelines of the organization. Gives the reason
 * to show the admin.
 */
export async function verifyBuildkiteAccess(input: {
  apiToken: string
  organizationSlug: string
  timeoutMs?: number
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let token: { scopes: string[] }
  try {
    token = await readJson(
      await buildkiteGet({
        apiToken: input.apiToken,
        path: "/access-token",
        maxWaitMs: BUILDKITE_INTERACTIVE_MAX_WAIT_MS,
        timeoutMs: input.timeoutMs,
      }),
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
  // ADR-054: no scope beyond the two. `read_user` and `read_organizations`
  // are not needed, because the admin types the slug.
  const extraScopes = token.scopes.filter(
    (scope) =>
      !(BUILDKITE_REQUIRED_SCOPES as readonly string[]).includes(scope),
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
  const graphql = await buildkiteGraphqlAccess(input)
  if (graphql === "enabled")
    return {
      ok: false,
      error:
        "The token has GraphQL API access. Edit the token in Buildkite and turn off GraphQL API access. The connector only reads.",
    }
  if (graphql === "unknown")
    return {
      ok: false,
      error:
        "ctx| cannot make sure that the token has no GraphQL API access. Try again later.",
    }
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines`,
    timeoutMs: input.timeoutMs,
    search: { per_page: "1" },
    maxWaitMs: BUILDKITE_INTERACTIVE_MAX_WAIT_MS,
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
  timeoutMs?: number
}): Promise<{
  pipelines: Array<{ slug: string; name: string }>
  truncated: boolean
}> {
  const pipelines: Array<{ slug: string; name: string }> = []
  for (let page = 1; page <= BUILDKITE_MAX_PIPELINE_PAGES; page += 1) {
    const response = await buildkiteGet({
      apiToken: input.apiToken,
      path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines`,
      timeoutMs: input.timeoutMs,
      search: { page: String(page), per_page: "100" },
      maxWaitMs: BUILDKITE_INTERACTIVE_MAX_WAIT_MS,
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
  timeoutMs?: number
}): Promise<BuildkitePipelineForMirror | "not_found" | "forbidden"> {
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines/${encodeURIComponent(input.pipelineSlug)}`,
    timeoutMs: input.timeoutMs,
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
  timeoutMs?: number
}): Promise<BuildkiteBuildForMirror[]> {
  const response = await buildkiteGet({
    apiToken: input.apiToken,
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}/pipelines/${encodeURIComponent(input.pipelineSlug)}/builds`,
    timeoutMs: input.timeoutMs,
    search: {
      state: "finished",
      per_page: String(BUILDKITE_BUILDS_PER_PIPELINE),
    },
  })
  return (await readJson(response, z.array(buildSchema), "build list")).map(
    toBuild,
  )
}
