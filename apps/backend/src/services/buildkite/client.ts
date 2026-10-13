import { z } from "zod"
import type {
  BuildkiteBuildForMirror,
  BuildkitePipelineForMirror,
} from "./converter.js"

const BUILDKITE_API = "https://api.buildkite.com/v2"

/** The REST scopes that the API access token must have (ADR-053). */
export const BUILDKITE_REQUIRED_SCOPES = [
  "read_organizations",
  "read_pipelines",
  "read_builds",
] as const

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
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
      },
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

const organizationSchema = z.object({ slug: z.string(), name: z.string() })

const pipelineSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: nullableString,
  web_url: z.string(),
  repository: nullableString,
  default_branch: nullableString,
  created_at: nullableString,
  archived_at: nullableString,
})

const personSchema = z.object({ name: nullableString }).nullish()

// Only the fields that the mirror renders. Zod drops the rest, so the build
// env, meta-data, and job commands never reach a file.
const buildSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  web_url: z.string(),
  state: z.string(),
  branch: nullableString,
  commit: nullableString,
  message: nullableString,
  created_at: nullableString,
  started_at: nullableString,
  finished_at: nullableString,
  creator: personSchema,
  author: personSchema,
  pull_request: z
    .object({ id: z.string(), repository: nullableString })
    .nullish(),
  jobs: z
    .array(
      z.object({
        type: z.string(),
        name: nullableString,
        state: nullableString,
        exit_status: z.number().int().nullish().default(null),
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
    description: pipeline.description,
    url: pipeline.web_url,
    repository: pipeline.repository,
    defaultBranch: pipeline.default_branch,
    createdAt: pipeline.created_at,
    archivedAt: pipeline.archived_at,
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
    message: build.message,
    createdAt: build.created_at,
    startedAt: build.started_at,
    finishedAt: build.finished_at,
    creatorName: build.creator?.name ?? null,
    authorName: build.author?.name ?? null,
    pullRequest: build.pull_request
      ? {
          number: build.pull_request.id,
          repository: build.pull_request.repository,
        }
      : null,
    // Wait steps and block steps have no result to show.
    jobs: build.jobs
      .filter((job) => job.type === "script" || job.type === "trigger")
      .map((job) => ({
        name: job.name?.trim() || "Unnamed step",
        state: job.state ?? "unknown",
        exitStatus: job.exit_status,
        softFailed: job.soft_failed ?? false,
        url: job.web_url,
      })),
  }
}

/**
 * Check that the token is valid, has the read scopes, and can read the
 * organization. Gives the organization, or the reason to show the admin.
 */
export async function verifyBuildkiteAccess(input: {
  apiToken: string
  organizationSlug: string
}): Promise<
  | { ok: true; organization: { slug: string; name: string } }
  | { ok: false; error: string }
> {
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
    path: `/organizations/${encodeURIComponent(input.organizationSlug)}`,
  })
  if (response.status === 403 || response.status === 404)
    return {
      ok: false,
      error: `The token cannot read the Buildkite organization "${input.organizationSlug}". Check the slug, and the organizations of the token.`,
    }
  return {
    ok: true,
    organization: await readJson(response, organizationSchema, "organization"),
  }
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
  return toPipeline(await readJson(response, pipelineSchema, "pipeline"))
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
