import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import type { GitHubInstallationShape } from "../../models/connection-rows.js"
import {
  githubConnectionToShape,
  githubRowHasAppCredentials,
} from "../../models/connection-rows.js"
import {
  completeGithubDraftCredentials,
  createDraftGithubConnection,
  createPlaceholderGithubConnection,
  deleteGithubConnectionById,
  getGithubConnectionRow,
  getGithubUserAccessToken,
  listAllReposForInstallation,
  listGithubConnectionRowsForOrg,
  listReposForInstallation,
  MULTIPLE_GITHUB_CONNECTIONS_MESSAGE,
  refreshGithubConnectionAccountSlug,
  registerInstallationOnConnection,
  resolveGithubInstallationForOrgDetailed,
  searchReposForInstallation,
  updateInstallationOptions,
  upsertInstallation,
  userCanAccessInstallation,
} from "../../models/github-installation.js"
import {
  createCtxpipeMcpConfigPullRequests,
  type McpOnboardingAgent,
  previewMcpConfigChanges,
} from "../../models/github-mcp-config-pr.js"
import {
  countRepositoriesForGithubConnection,
  ensureGithubConnectionRepositories,
  listRepositoriesForGithubConnection,
  pruneGithubConnectionRepositoriesNotInGitUrls,
} from "../../models/repositories.js"
import { runWorkflowWithWorkerWake } from "../../openworkflow/client.js"
import { enqueueRepositoryIngestionWorkflow } from "../../openworkflow/enqueue-repository-ingestion.js"
import { syncGithubRepositories } from "../../openworkflow/workflows/sync-github-repositories.js"

const ErrorResponseSchema = z
  .object({
    // Legacy client error shape
    error: z.string().optional(),
    code: z.string().optional(),
    // evlog structured error shape (varies by transport)
    statusCode: z.number().optional(),
    message: z.string().optional(),
    why: z.string().optional(),
    fix: z.string().optional(),
    link: z.string().url().optional(),
    data: z
      .object({
        why: z.string().optional(),
        fix: z.string().optional(),
        link: z.string().url().optional(),
      })
      .optional(),
  })
  .openapi("ErrorResponse")

const RegisterInstallationBodySchema = z
  .object({
    installationId: z.number(),
    /** When completing install for a draft row created via POST .../draft. */
    connectionId: z.string().min(1).optional(),
  })
  .openapi("RegisterInstallationBody")

const CreateGithubDraftBodySchema = z
  .object({
    githubAppId: z.string().min(1),
    appSlug: z.string().min(1),
    privateKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .openapi("CreateGithubDraftBody")

const PatchGithubDraftBodySchema = CreateGithubDraftBodySchema.extend({
  connectionId: z.string().min(1),
}).openapi("PatchGithubDraftBody")

const GithubDraftPlaceholderResponseSchema = z
  .object({
    id: z.string(),
    webhookUrl: z.string().url(),
  })
  .openapi("GithubDraftPlaceholderResponse")

const GitHubInstallationSchema = z
  .object({
    id: z.string(),
    installationId: z.number().nullable(),
    orgId: z.string(),
    appSlug: z.string().nullable().optional(),
    accountSlug: z.string().nullable(),
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    ingestionRepositoryCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("GitHubInstallation")

const GithubConnectorBootstrapResponseSchema = z
  .object({
    publicApiOrigin: z.string().url(),
    suggestedWebhookUrlTemplate: z.string(),
    githubAppConfiguredInEnv: z.boolean(),
    rowsNeedingSecrets: z.number().int(),
    /** When set, one-click install URL for the platform default app (slug from env or `ctxpipe-agent`). */
    hostedDefaultAppInstallUrl: z.string().url().nullable(),
  })
  .openapi("GithubConnectorBootstrap")

function hostedDefaultGithubAppInstallUrl(env: {
  GITHUB_APP_ID?: string | null
  GITHUB_PRIVATE_KEY?: string | null
  GITHUB_APP_SLUG?: string | null
}): string | null {
  const slug = env.GITHUB_APP_SLUG?.trim() || "ctxpipe-agent"
  const hasApp =
    Boolean(env.GITHUB_APP_ID?.trim()) &&
    Boolean(env.GITHUB_PRIVATE_KEY?.trim())
  if (!hasApp) return null
  return `https://github.com/apps/${slug}/installations/select_target`
}

async function githubInstallationResponsePayload(
  installation: GitHubInstallationShape,
) {
  const ingestionRepositoryCount = await countRepositoriesForGithubConnection(
    installation.id,
  )
  return {
    id: installation.id,
    orgId: installation.orgId,
    appSlug: installation.appSlug,
    installationId: installation.installationId,
    accountSlug: installation.accountSlug,
    ingestAllRepositories: installation.ingestAllRepositories,
    includeFutureRepos: installation.includeFutureRepos,
    createdAt: installation.createdAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
    ingestionRepositoryCount,
  }
}

const GITHUB_INSTALLATION_UNAVAILABLE_MESSAGE =
  "GitHub installation is no longer available. Reconnect GitHub from the Connectors page."

function isGitHubInstallationUnavailableError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const status =
    "status" in e && typeof (e as { status: unknown }).status === "number"
      ? (e as { status: number }).status
      : undefined
  if (status === 404) return true
  return e.message.includes("create-an-installation-access-token-for-an-app")
}

const GitHubRepoItemSchema = z
  .object({
    id: z.number(),
    full_name: z.string(),
    html_url: z.string(),
    clone_url: z.string(),
    name: z.string(),
    default_branch: z.string(),
  })
  .openapi("GitHubRepoItem")

const ListInstallationReposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
  q: z.string().optional(),
})

const ListInstallationReposResponseSchema = z
  .object({
    repositories: z.array(GitHubRepoItemSchema),
    repositorySelection: z.string(),
    hasMore: z.boolean(),
    totalCount: z.number().optional(),
    warning: z.string().optional(),
  })
  .openapi("ListInstallationReposResponse")

const SelectedRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  clone_url: z.string(),
})

const UpdateInstallationOptionsBodySchema = z
  .object({
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    selectedRepositories: z.array(SelectedRepoSchema).optional(),
  })
  .openapi("UpdateInstallationOptionsBody")

const SavedRepoSchema = z.object({
  name: z.string(),
  gitUrl: z.string(),
})

const GitHubInstallationSetupResponseSchema = z
  .object({
    ingestAllRepositories: z.boolean(),
    includeFutureRepos: z.boolean(),
    savedRepositories: z.array(SavedRepoSchema),
  })
  .openapi("GitHubInstallationSetupResponse")

const GithubConnectionIdQuerySchema = z.object({
  connectionId: z.string().min(1).optional(),
})

export const getInstallationSetupRoute = createRoute({
  method: "get",
  path: "/setup",
  request: {
    query: GithubConnectionIdQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSetupResponseSchema,
        },
      },
      description:
        "Installation settings and previously saved repositories for pre-filling the setup form",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple installations — pass connectionId",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
  },
})

export const getInstallationRoute = createRoute({
  method: "get",
  path: "/",
  request: {
    query: GithubConnectionIdQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description:
        "GitHub installation for the org, or JSON `null` when not installed",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple installations — pass connectionId",
    },
  },
})

export const registerInstallationRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: {
        "application/json": {
          schema: RegisterInstallationBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description: "Installation registered or updated",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub account not linked",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const githubConnectorBootstrapRoute = createRoute({
  method: "get",
  path: "/connector-bootstrap",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GithubConnectorBootstrapResponseSchema,
        },
      },
      description: "URLs and status for GitHub App / connector setup wizard",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

export const createGithubDraftRoute = createRoute({
  method: "post",
  path: "/draft",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateGithubDraftBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description:
        "Draft GitHub connection created (install app next, then POST / with installationId)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const createGithubDraftPlaceholderRoute = createRoute({
  method: "post",
  path: "/draft/placeholder",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GithubDraftPlaceholderResponseSchema,
        },
      },
      description:
        "Reserved connection id and stable webhook URL before saving app credentials",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const patchGithubDraftRoute = createRoute({
  method: "patch",
  path: "/draft",
  request: {
    body: {
      content: {
        "application/json": {
          schema: PatchGithubDraftBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description:
        "Credentials saved on an existing draft / placeholder connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

const GithubConnectorStatusQuerySchema = z.object({
  connectionId: z.string().min(1),
})

const GithubConnectorStatusResponseSchema = z
  .object({
    connectionId: z.string(),
    installationComplete: z.boolean(),
    hasAppCredentials: z.boolean(),
    webhookUrl: z.string().url(),
    githubAppInstallSelectUrl: z.string().url().nullable(),
    suggestedNextStep: z.enum(["save_credentials", "install_app", "complete"]),
  })
  .openapi("GithubConnectorStatus")

export const githubConnectorStatusRoute = createRoute({
  method: "get",
  path: "/connector-status",
  request: {
    query: GithubConnectorStatusQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GithubConnectorStatusResponseSchema,
        },
      },
      description:
        "Pollable connector setup state for a draft or active GitHub connection",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unknown GitHub connection",
    },
  },
})

export const listInstallationReposRoute = createRoute({
  method: "get",
  path: "/repositories",
  request: {
    query: ListInstallationReposQuerySchema.extend({
      connectionId: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ListInstallationReposResponseSchema,
        },
      },
      description: "List repos accessible to the org's GitHub App installation",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple installations — pass connectionId",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

const McpOnboardingAgentSchema = z.enum(["cursor", "claude_code", "opencode"])

const CreateMcpConfigPrBodySchema = z
  .object({
    repositories: z.array(z.string().min(1).max(200)).min(1).max(25),
    agents: z.array(McpOnboardingAgentSchema).min(1).max(10),
  })
  .openapi("CreateMcpConfigPrBody")

const CreateMcpConfigPrResponseSchema = z
  .object({
    pullRequests: z.array(
      z.object({
        repository: z.string(),
        pullRequestUrl: z.string().url(),
      }),
    ),
    failures: z.array(
      z.object({
        repository: z.string(),
        error: z.string(),
        status: z.number().int().optional(),
        documentationUrl: z.string().optional(),
        errors: z.unknown().optional(),
      }),
    ),
  })
  .openapi("CreateMcpConfigPrResponse")

const McpConfigPreviewFileSchema = z
  .object({
    repository: z.string(),
    path: z.string(),
    exists: z.boolean(),
    existingUtf8: z.string().nullable(),
    mergedUtf8: z.string(),
  })
  .openapi("McpConfigPreviewFile")

const McpConfigPreviewResponseSchema = z
  .object({
    files: z.array(McpConfigPreviewFileSchema),
  })
  .openapi("McpConfigPreviewResponse")

export const previewMcpConfigRoute = createRoute({
  method: "post",
  path: "/mcp-config-preview",
  request: {
    query: GithubConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: CreateMcpConfigPrBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: McpConfigPreviewResponseSchema,
        },
      },
      description:
        "Preview merged MCP config files as they would appear on the default branch",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Bad request (e.g. repository not accessible to installation)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const createMcpConfigPrsRoute = createRoute({
  method: "post",
  path: "/mcp-config-prs",
  request: {
    query: GithubConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: CreateMcpConfigPrBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CreateMcpConfigPrResponseSchema,
        },
      },
      description:
        "Opened one pull request per repository with MCP config files",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Bad request (e.g. repository not accessible to installation)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No installation for org",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const updateInstallationOptionsRoute = createRoute({
  method: "patch",
  path: "/",
  request: {
    query: GithubConnectionIdQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: UpdateInstallationOptionsBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GitHubInstallationSchema,
        },
      },
      description: "Installation options updated",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple installations — pass connectionId",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Internal server error",
    },
  },
})

export const deleteInstallationRoute = createRoute({
  method: "delete",
  path: "/",
  request: {
    query: GithubConnectionIdQuerySchema,
  },
  responses: {
    204: {
      description: "GitHub connector removed for this organization",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Multiple installations — pass connectionId",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

export const githubInstallationReadRoutes = new OpenAPIHono<AppEnv>()
  .openapi(githubConnectorBootstrapRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const env = c.var.env
    const rows = await listGithubConnectionRowsForOrg(orgId)
    let rowsNeedingSecrets = 0
    for (const row of rows) {
      if (!githubRowHasAppCredentials(row, env)) rowsNeedingSecrets += 1
    }
    const publicApiOrigin = env.AUTH_BASE_URL.replace(/\/$/, "")
    return c.json(
      {
        publicApiOrigin,
        suggestedWebhookUrlTemplate: `${publicApiOrigin}/api/v1/webhook/github/<connectionId>`,
        githubAppConfiguredInEnv: Boolean(
          env.GITHUB_APP_ID?.trim() && env.GITHUB_PRIVATE_KEY?.trim(),
        ),
        rowsNeedingSecrets,
        hostedDefaultAppInstallUrl: hostedDefaultGithubAppInstallUrl(env),
      },
      200,
    )
  })
  .openapi(
    getInstallationRoute,
    // `null` body is valid at runtime; OpenAPI schema is the non-null object for codegen.
    (async (c: Context<AppEnv>) => {
      if (!c.get("user") || !c.get("session")) {
        return c.json({ error: "Unauthorized" }, 401)
      }
      const orgId = c.get("orgId")
      if (!orgId) return c.json({ error: "Not found" }, 404)
      const { connectionId } = GithubConnectionIdQuerySchema.parse({
        connectionId: c.req.query("connectionId") ?? undefined,
      })
      const resolved = await resolveGithubInstallationForOrgDetailed(
        orgId,
        connectionId ?? null,
      )
      if (resolved.status === "ambiguous") {
        return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
      }
      if (resolved.status === "none") {
        return c.json(null, 200)
      }
      const env = c.var.env
      let installation = resolved.installation
      if (!installation.accountSlug) {
        installation =
          (await refreshGithubConnectionAccountSlug(
            orgId,
            installation.id,
            env,
          )) ?? installation
      }
      return c.json(await githubInstallationResponsePayload(installation), 200)
    }) as never,
  )

export const githubInstallationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getInstallationSetupRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const { connectionId } = GithubConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveGithubInstallationForOrgDetailed(
      orgId,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const installation = resolved.installation
    const repos = await listRepositoriesForGithubConnection(installation.id)
    return c.json(
      {
        ingestAllRepositories: installation.ingestAllRepositories,
        includeFutureRepos: installation.includeFutureRepos,
        savedRepositories: repos.map((r) => ({
          name: r.name,
          gitUrl: r.gitUrl,
        })),
      },
      200,
    )
  })
  .openapi(githubConnectorBootstrapRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const env = c.var.env
    const rows = await listGithubConnectionRowsForOrg(orgId)
    let rowsNeedingSecrets = 0
    for (const row of rows) {
      if (!githubRowHasAppCredentials(row, env)) rowsNeedingSecrets += 1
    }
    const publicApiOrigin = env.AUTH_BASE_URL.replace(/\/$/, "")
    return c.json(
      {
        publicApiOrigin,
        suggestedWebhookUrlTemplate: `${publicApiOrigin}/api/v1/webhook/github/<connectionId>`,
        githubAppConfiguredInEnv: Boolean(
          env.GITHUB_APP_ID?.trim() && env.GITHUB_PRIVATE_KEY?.trim(),
        ),
        rowsNeedingSecrets,
        hostedDefaultAppInstallUrl: hostedDefaultGithubAppInstallUrl(env),
      },
      200,
    )
  })
  .openapi(createGithubDraftRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
      const installation = await createDraftGithubConnection({
        orgId,
        env: c.var.env,
        githubAppId: body.githubAppId,
        appSlug: body.appSlug,
        privateKey: body.privateKey,
        webhookSecret: body.webhookSecret,
      })
      return c.json(await githubInstallationResponsePayload(installation), 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.create_draft",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(createGithubDraftPlaceholderRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const env = c.var.env
    try {
      const installation = await createPlaceholderGithubConnection({ orgId })
      const publicApiOrigin = env.AUTH_BASE_URL.replace(/\/$/, "")
      const webhookUrl = `${publicApiOrigin}/api/v1/webhook/github/${installation.id}`
      return c.json({ id: installation.id, webhookUrl }, 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.create_draft_placeholder",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(patchGithubDraftRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
      const installation = await completeGithubDraftCredentials({
        orgId,
        connectionId: body.connectionId,
        env: c.var.env,
        githubAppId: body.githubAppId,
        appSlug: body.appSlug,
        privateKey: body.privateKey,
        webhookSecret: body.webhookSecret,
      })
      if (!installation) {
        return c.json({ error: "Unknown GitHub connection" }, 404)
      }
      return c.json(await githubInstallationResponsePayload(installation), 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.patch_draft",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(githubConnectorStatusRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const { connectionId } = c.req.valid("query")
    const env = c.var.env
    const row = await getGithubConnectionRow(orgId, connectionId)
    if (!row) {
      return c.json({ error: "Unknown GitHub connection" }, 404)
    }
    const shape = githubConnectionToShape(row)
    const hasAppCredentials = githubRowHasAppCredentials(row, env)
    const installationComplete = shape.installationId != null
    const publicApiOrigin = env.AUTH_BASE_URL.replace(/\/$/, "")
    const webhookUrl = `${publicApiOrigin}/api/v1/webhook/github/${connectionId}`
    const slug = shape.appSlug?.trim()
    const githubAppInstallSelectUrl = slug
      ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/select_target`
      : null
    let suggestedNextStep: "save_credentials" | "install_app" | "complete"
    if (installationComplete) {
      suggestedNextStep = "complete"
    } else if (!hasAppCredentials) {
      suggestedNextStep = "save_credentials"
    } else {
      suggestedNextStep = "install_app"
    }
    return c.json(
      {
        connectionId,
        installationComplete,
        hasAppCredentials,
        webhookUrl,
        githubAppInstallSelectUrl,
        suggestedNextStep,
      },
      200,
    )
  })
  .openapi(registerInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const body = c.req.valid("json")
    try {
      const user = c.get("user") as { id: string }
      const githubAccessToken = await getGithubUserAccessToken(user.id)
      if (githubAccessToken) {
        const canAccess = await userCanAccessInstallation(
          githubAccessToken,
          body.installationId,
        )
        if (!canAccess) {
          return c.json({ error: "Forbidden" }, 403)
        }
      }

      let installation: GitHubInstallationShape

      if (body.connectionId) {
        const linked = await registerInstallationOnConnection({
          orgId,
          connectionId: body.connectionId,
          installationId: body.installationId,
          env: c.var.env,
        })
        if (!linked) {
          return c.json({ error: "Unknown GitHub connection" }, 404)
        }
        installation = linked
      } else {
        installation = await upsertInstallation(
          orgId,
          body.installationId,
          c.var.env,
        )
        installation =
          (await refreshGithubConnectionAccountSlug(
            orgId,
            installation.id,
            c.var.env,
          )) ?? installation
      }

      return c.json(await githubInstallationResponsePayload(installation), 200)
    } catch (e) {
      if (e instanceof Error && e.name === "EvlogError") {
        throw e
      }
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.register",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(listInstallationReposRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const query = ListInstallationReposQuerySchema.extend({
      connectionId: z.string().min(1).optional(),
    }).parse({
      page: c.req.query("page"),
      per_page: c.req.query("per_page"),
      q: c.req.query("q"),
      connectionId: c.req.query("connectionId"),
    })
    const resolved = await resolveGithubInstallationForOrgDetailed(
      orgId,
      query.connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const installation = resolved.installation
    const env = c.var.env
    if (installation.installationId == null) {
      return c.json(
        {
          repositories: [],
          repositorySelection: "unavailable",
          hasMore: false,
          warning:
            "GitHub App installation is not linked yet. Finish install from GitHub, then register the installation.",
        },
        200,
      )
    }
    try {
      // Use server-side search when query is provided, otherwise list repos
      if (query.q?.trim()) {
        const result = await searchReposForInstallation(
          orgId,
          installation.id,
          env,
          query.q,
          query.page,
          query.per_page,
        )
        return c.json(
          {
            repositories: result.repositories,
            repositorySelection: "selected",
            hasMore: result.hasMore,
            totalCount: result.totalCount,
          },
          200,
        )
      } else {
        const result = await listReposForInstallation(
          orgId,
          installation.id,
          env,
          query.page,
          query.per_page,
        )
        return c.json(result, 200)
      }
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.list_repos",
      })
      if (isGitHubInstallationUnavailableError(e)) {
        return c.json(
          {
            repositories: [],
            repositorySelection: "unavailable",
            hasMore: false,
            warning: GITHUB_INSTALLATION_UNAVAILABLE_MESSAGE,
          },
          200,
        )
      }
      return c.json(
        {
          error: "Failed to list GitHub repositories for this installation",
        },
        500,
      )
    }
  })
  .openapi(updateInstallationOptionsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const { connectionId: patchConnectionId } =
      GithubConnectionIdQuerySchema.parse({
        connectionId: c.req.query("connectionId") ?? undefined,
      })
    const body = UpdateInstallationOptionsBodySchema.parse(await c.req.json())
    try {
      const resolved = await resolveGithubInstallationForOrgDetailed(
        orgId,
        patchConnectionId ?? null,
      )
      if (resolved.status === "ambiguous") {
        return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
      }
      if (resolved.status === "none") {
        return c.json(
          { error: "No GitHub installation found for this org" },
          404,
        )
      }

      const selectedRepos = body.selectedRepositories ?? []
      if (!body.ingestAllRepositories && selectedRepos.length === 0) {
        return c.json({ error: "Select at least one repository" }, 400)
      }

      const installation = await updateInstallationOptions(
        orgId,
        resolved.installation.id,
        {
          ingestAllRepositories: body.ingestAllRepositories,
          includeFutureRepos: body.includeFutureRepos,
        },
      )
      if (!installation) {
        return c.json(
          { error: "No GitHub installation found for this org" },
          404,
        )
      }

      if (!body.ingestAllRepositories) {
        const allowedGitUrls = new Set(selectedRepos.map((r) => r.clone_url))
        await pruneGithubConnectionRepositoriesNotInGitUrls(
          orgId,
          installation.id,
          allowedGitUrls,
        )
      }

      if (body.ingestAllRepositories) {
        const workflowPayload = { orgId, githubConnectionId: installation.id }
        if (installation.installationId != null) {
          void runWorkflowWithWorkerWake(
            syncGithubRepositories.spec,
            workflowPayload,
          )
        }
      } else {
        const repos = await ensureGithubConnectionRepositories(
          orgId,
          installation.id,
          selectedRepos.map((r) => ({
            name: r.full_name,
            gitUrl: r.clone_url,
          })),
        )
        await Promise.all(
          repos.map((repo) =>
            enqueueRepositoryIngestionWorkflow(
              { repositoryId: repo.id, orgId: repo.orgId },
              {
                error: (err) =>
                  c.get("log").error(err, {
                    step: "github_installation.update_options.enqueue-ingestion",
                    repositoryId: repo.id,
                  }),
              },
            ),
          ),
        )
      }

      return c.json(await githubInstallationResponsePayload(installation), 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.update_options",
      })
      return c.json({ error: "Internal server error" }, 500)
    }
  })
  .openapi(deleteInstallationRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const { connectionId } = GithubConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const resolved = await resolveGithubInstallationForOrgDetailed(
      orgId,
      connectionId ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const ok = await deleteGithubConnectionById(orgId, resolved.installation.id)
    if (!ok) {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    return c.body(null, 204)
  })
  .openapi(previewMcpConfigRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const orgSlug = c.req.param("orgSlug")
    if (!orgSlug) return c.json({ error: "Not found" }, 404)

    const { connectionId: mcpConn } = GithubConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const body = CreateMcpConfigPrBodySchema.parse(await c.req.json())
    const resolved = await resolveGithubInstallationForOrgDetailed(
      orgId,
      mcpConn ?? null,
    )
    if (resolved.status === "ambiguous") {
      return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolved.status === "none") {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const installation = resolved.installation

    const env = c.var.env
    let accessible: Awaited<ReturnType<typeof listAllReposForInstallation>>
    try {
      if (installation.installationId == null) {
        accessible = []
      } else {
        accessible = await listAllReposForInstallation(
          orgId,
          installation.id,
          env,
        )
      }
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.mcp_preview_list_repos",
      })
      return c.json(
        {
          error: e instanceof Error ? e.message : "Failed to list repositories",
        },
        500,
      )
    }

    const allowed = new Set(accessible.map((r) => r.full_name))
    const requested: string[] = [...new Set(body.repositories)]
    const notAllowed = requested.filter((name) => !allowed.has(name))
    if (notAllowed.length > 0) {
      return c.json(
        {
          error: `Repositories not accessible to this GitHub installation: ${notAllowed.join(", ")}`,
        },
        400,
      )
    }

    const agents = [...new Set(body.agents)] as McpOnboardingAgent[]

    try {
      const files = await previewMcpConfigChanges({
        orgId,
        orgSlug,
        env,
        githubConnectionId: installation.id,
        repositories: requested,
        agents,
      })
      return c.json({ files }, 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.mcp_preview",
      })
      return c.json(
        {
          error:
            e instanceof Error ? e.message : "Failed to preview MCP config",
        },
        500,
      )
    }
  })
  .openapi(createMcpConfigPrsRoute, async (c) => {
    if (!c.get("user") || !c.get("session")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    const orgId = c.get("orgId")
    if (!orgId) return c.json({ error: "Not found" }, 404)
    const orgSlug = c.req.param("orgSlug")
    if (!orgSlug) return c.json({ error: "Not found" }, 404)

    const { connectionId: mcpPrConn } = GithubConnectionIdQuerySchema.parse({
      connectionId: c.req.query("connectionId") ?? undefined,
    })
    const body = CreateMcpConfigPrBodySchema.parse(await c.req.json())
    const resolvedPr = await resolveGithubInstallationForOrgDetailed(
      orgId,
      mcpPrConn ?? null,
    )
    if (resolvedPr.status === "ambiguous") {
      return c.json({ error: MULTIPLE_GITHUB_CONNECTIONS_MESSAGE }, 400)
    }
    if (resolvedPr.status === "none") {
      return c.json({ error: "No GitHub installation found for this org" }, 404)
    }
    const installation = resolvedPr.installation

    const env = c.var.env
    let accessible: Awaited<ReturnType<typeof listAllReposForInstallation>>
    try {
      if (installation.installationId == null) {
        accessible = []
      } else {
        accessible = await listAllReposForInstallation(
          orgId,
          installation.id,
          env,
        )
      }
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.mcp_pr_list_repos",
      })
      return c.json(
        {
          error: e instanceof Error ? e.message : "Failed to list repositories",
        },
        500,
      )
    }

    const allowed = new Set(accessible.map((r) => r.full_name))
    const requested: string[] = [...new Set(body.repositories)]
    const notAllowed = requested.filter((name) => !allowed.has(name))
    if (notAllowed.length > 0) {
      return c.json(
        {
          error: `Repositories not accessible to this GitHub installation: ${notAllowed.join(", ")}`,
        },
        400,
      )
    }

    const agents = [...new Set(body.agents)] as McpOnboardingAgent[]

    try {
      const log = c.get("log")
      const { pullRequests, failures } =
        await createCtxpipeMcpConfigPullRequests({
          orgId,
          orgSlug,
          env,
          githubConnectionId: installation.id,
          repositories: requested,
          agents,
          onRepoFailure: ({ repository, error, detail }) => {
            // Per-repo failure: log with the repo name + GitHub-provided detail
            // so we can tell which repo tripped which kind of 422/403/etc.
            // instead of an anonymous batch-level "Reference update failed".
            log.error(
              error instanceof Error ? error : new Error(String(error)),
              {
                step: "github_installation.mcp_create_pr_repo",
                repository,
                status: detail.status,
                documentationUrl: detail.documentationUrl,
                errors: detail.errors,
              },
            )
          },
        })
      return c.json({ pullRequests, failures }, 200)
    } catch (e) {
      c.get("log").error(e instanceof Error ? e : new Error(String(e)), {
        step: "github_installation.mcp_create_prs",
      })
      return c.json(
        {
          error:
            e instanceof Error ? e.message : "Failed to open pull requests",
        },
        500,
      )
    }
  })
