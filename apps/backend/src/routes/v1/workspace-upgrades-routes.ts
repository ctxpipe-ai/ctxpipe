import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { directWriteRoute } from "../../auth/write-grant.js"
import {
  GIT_UPGRADE_STEPS,
  pendingUpgradeSteps,
  UPGRADE_BLOCKED_REASONS,
  UPGRADE_STATUSES,
  type UpgradeStatus,
} from "../../domain/upgrades/registry.js"
import { startWorkspaceUpgrade } from "../../domain/upgrades/start.js"
import { CODE_FORMAT } from "../../domain/workspaces/workspace-format.js"
import {
  failStoppedUpgradeRun,
  listWorkspaceUpgradeRows,
  type WorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { getWorkspaceBySlug } from "../../models/workspaces.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
} from "./workspace-route-shared.js"

const UpgradeStatusSchema = z.enum(
  Object.values(UPGRADE_STATUSES) as [UpgradeStatus, ...UpgradeStatus[]],
)

const WorkspaceUpgradeItemSchema = z
  .object({
    key: z.string().openapi({
      description:
        "`format-<N>`: the git upgrade of the Workspace repository to format N.",
    }),
    kind: z.literal("format"),
    title: z.string(),
    status: UpgradeStatusSchema.openapi({
      description:
        "`awaiting_operator`: waits for an owner or admin to start it. `queued` and `running`: ctx| prepares the pull request. `pr_open`: merge the pull request to apply it. `completed`: the repository has the target format. `failed`: see `failureReason`; start it again. `blocked`: see `blockedReason` and `note`.",
    }),
    fromFormat: z.number().int(),
    targetFormat: z.number().int(),
    steps: z
      .array(
        z.object({
          format: z.number().int(),
          title: z.string(),
          commitSha: z.string().nullable(),
          report: z.array(z.string()),
        }),
      )
      .openapi({
        description:
          "The steps of the upgrade, in order. `commitSha` and `report` come from the last run; a step with no change has no commit.",
      }),
    pullRequest: z
      .object({ number: z.number().int().nullable(), url: z.string() })
      .nullable(),
    blockedReason: z
      .enum(Object.values(UPGRADE_BLOCKED_REASONS) as [string, ...string[]])
      .nullable(),
    note: z.string().nullable(),
    failureReason: z.string().nullable(),
    approvedBy: z.string().nullable().openapi({
      description: "The user id of the owner or admin who started it.",
    }),
    approvedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .openapi("WorkspaceUpgradeItem")

const WorkspaceUpgradesSchema = z
  .object({
    formatVersion: z.number().int().nullable().openapi({
      description:
        "The format of the Workspace repository that ctx| read last. `null`: not read yet. `-1`: the format file is not valid.",
    }),
    codeFormat: z.number().int().openapi({
      description: "The newest format that this ctx| version reads and writes.",
    }),
    items: z.array(WorkspaceUpgradeItemSchema),
  })
  .openapi("WorkspaceUpgrades")

const UpgradeParamsSchema = WorkspaceSlugParamsSchema.extend({
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .openapi({ description: "The upgrade key, for example `format-3`." }),
}).openapi("WorkspaceUpgradeParams")

function serializeUpgrade(
  row: WorkspaceUpgradeRow,
): z.infer<typeof WorkspaceUpgradeItemSchema> {
  const { upgrade } = row
  const steps =
    upgrade.steps ??
    pendingUpgradeSteps(
      GIT_UPGRADE_STEPS,
      upgrade.fromFormat,
      Math.min(upgrade.targetFormat, GIT_UPGRADE_STEPS.length),
    ).map((step) => ({ ...step, sha: null, report: [] }))
  return {
    key: upgrade.key,
    kind: "format",
    title: `Upgrade to format ${upgrade.targetFormat}`,
    status: row.status,
    fromFormat: upgrade.fromFormat,
    targetFormat: upgrade.targetFormat,
    steps: steps.map((step) => ({
      format: step.format,
      title: step.title,
      commitSha: step.sha,
      report: step.report,
    })),
    pullRequest: upgrade.prUrl
      ? { number: upgrade.prNumber ?? null, url: upgrade.prUrl }
      : null,
    blockedReason: upgrade.blockedReason ?? null,
    note: upgrade.note ?? null,
    failureReason: row.failureReason,
    approvedBy: upgrade.approvedBy ?? null,
    approvedAt: upgrade.approvedAt ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

const listUpgradesRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/upgrades",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: WorkspaceUpgradesSchema } },
      description:
        "The format of the Workspace and its upgrades. Every member can read them; only an owner or admin can start one.",
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

const startUpgradeRoute = createRoute(
  directWriteRoute(
    {
      method: "post",
      path: "/{workspaceSlug}/upgrades/{key}/start",
      request: { params: UpgradeParamsSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: WorkspaceUpgradeItemSchema },
          },
          description:
            "The upgrade was started before. Nothing new starts, and no second pull request opens.",
        },
        202: {
          content: {
            "application/json": { schema: WorkspaceUpgradeItemSchema },
          },
          description:
            "The upgrade is queued. ctx| opens a pull request on the branch `ctxpipe/upgrade/<key>`. ctx| never pushes to the default branch.",
        },
        401: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "Unauthorized",
        },
        404: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "The Workspace or the upgrade does not exist",
        },
        409: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "The upgrade is blocked, or it is already applied",
        },
      },
    },
    { orgAdmin: true },
  ),
)

const routes = new OpenAPIHono<AppEnv>()
  .openapi(listUpgradesRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    // Show a run that stopped without its result as `failed`.
    await failStoppedUpgradeRun(workspace.id)
    const rows = await listWorkspaceUpgradeRows(workspace.id)
    return c.json(
      {
        formatVersion: workspace.formatVersion,
        codeFormat: CODE_FORMAT,
        items: rows.map(serializeUpgrade),
      },
      200,
    )
  })
  .openapi(startUpgradeRoute, async (c) => {
    const user = c.get("user")
    const orgId = c.get("orgId")
    if (!user || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug, key } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const result = await startWorkspaceUpgrade({
      orgId,
      workspaceId: workspace.id,
      key,
      userId: user.id,
    })
    switch (result.kind) {
      case "missing":
        return c.json({ error: "Not found" }, 404)
      case "blocked":
        return c.json(
          { error: result.row.upgrade.note ?? "The upgrade cannot start now" },
          409,
        )
      case "completed":
        return c.json({ error: "The upgrade is already applied" }, 409)
      case "existing":
        return c.json(serializeUpgrade(result.row), 200)
      case "queued":
        return c.json(serializeUpgrade(result.row), 202)
    }
  })

/**
 * The Upgrades of a Workspace (ADR-053 section 7). Only an org owner or
 * admin with a session may start one: the admin check reads a Better Auth
 * session, so it refuses an OAuth token, and the write gate refuses an API
 * key. Each upgrade needs its own click; there is no org-wide approval.
 */
const gated = new OpenAPIHono<AppEnv>()
gated.use("/:workspaceSlug/upgrades/:key/start", requireOrgAdminOrOwner)
export const workspaceUpgradeRoutes = gated.route("/", routes)
