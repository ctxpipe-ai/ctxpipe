import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { requireOrgAdminOrOwner } from "../../auth/withAuth.js"
import { directWriteRoute } from "../../auth/write-grant.js"
import {
  readUpgradeMode,
  setUpgradeMode,
} from "../../domain/upgrades/automatic.js"
import {
  classifyUpgradeFailure,
  UPGRADE_FAILURE_CODES,
  UPGRADE_FAILURE_STEPS,
} from "../../domain/upgrades/failure.js"
import {
  GIT_UPGRADE_STEPS,
  pendingUpgradeSteps,
  REINGEST_DESCRIPTION,
  UPGRADE_BLOCKED_REASONS,
  UPGRADE_RUN_STAGES,
  UPGRADE_STATUSES,
  type UpgradeStatus,
} from "../../domain/upgrades/registry.js"
import { isReingestUpgradeKey } from "../../domain/upgrades/reingest.js"
import { startWorkspaceUpgrade } from "../../domain/upgrades/start.js"
import { CODE_FORMAT } from "../../domain/workspaces/workspace-format.js"
import { generateObjectId } from "../../lib/id.js"
import {
  listOrgPendingUpgradeRows,
  listWorkspaceUpgradeRows,
  type WorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  getWorkspaceBySlug,
  listOrgWorkspaces,
} from "../../models/workspaces.js"
import { enqueueWorkspaceTipCheck } from "../../openworkflow/enqueue-workspace-tip-check.js"
import { enqueueWorkspaceUpgradeScan } from "../../openworkflow/workflows/workspace-upgrade-scan.js"
import {
  ErrorResponseSchema,
  WorkspaceSlugParamsSchema,
} from "./workspace-route-shared.js"

const UpgradeStatusSchema = z.enum(
  Object.values(UPGRADE_STATUSES) as [UpgradeStatus, ...UpgradeStatus[]],
)

const UpgradeModeSchema = z.enum(["manual", "automatic"])

const RangeSchema = z.object({ low: z.number(), high: z.number() })

const ReingestEstimateSchema = z
  .object({
    repositories: z.number().int(),
    costUsd: RangeSchema,
    minutes: RangeSchema,
    perRepository: z.array(
      z.object({
        repository: z.string(),
        roots: RangeSchema,
        costUsd: RangeSchema,
        minutes: RangeSchema,
        basis: z.enum(["history", "heuristic"]),
      }),
    ),
  })
  .openapi("ReingestEstimate")

const WorkspaceUpgradeItemSchema = z
  .object({
    key: z.string().openapi({
      description:
        "`format-<N>`: the git upgrade of the Workspace repository to format N. `reingest-<bundle>`: the fresh re-ingestion of the source repositories with that skill bundle.",
    }),
    kind: z.enum(["format", "reingest"]),
    title: z.string(),
    description: z.string().openapi({
      description:
        "What the upgrade does to the Workspace repository, in plain words: the files that it adds, moves or rewrites.",
    }),
    status: UpgradeStatusSchema.openapi({
      description:
        "`awaiting_operator`: waits for an owner or admin to start it. `queued` and `running`: ctxpipe prepares the pull request. `pr_open`: merge the pull request to apply it. `completed`: the repository has the target format. `failed`: see `failureReason`; start it again. `blocked`: see `blockedReason` and `note`.",
    }),
    fromFormat: z.number().int(),
    targetFormat: z.number().int().openapi({
      description:
        "The format that a git upgrade gives. On a re-ingestion: the format that it needs.",
    }),
    steps: z
      .array(
        z.object({
          format: z.number().int(),
          title: z.string(),
          commitSha: z.string().nullable(),
          report: z.array(z.string()),
          notices: z
            .array(
              z.object({
                kind: z.enum(["action", "risk"]),
                text: z.string(),
              }),
            )
            .optional()
            .openapi({
              description:
                "The lines of `report` that the user must know, in plain words: `action` is a thing to do, `risk` is knowledge or a setting that ctxpipe cannot keep or make again. The UI shows these lines and keeps `report` behind Details.",
            }),
        }),
      )
      .openapi({
        description:
          "The steps of the upgrade, in order. `commitSha`, `report` and `notices` come from the last run; a step with no change has no commit.",
      }),
    pullRequest: z
      .object({ number: z.number().int().nullable(), url: z.string() })
      .nullable(),
    estimate: ReingestEstimateSchema.nullable().openapi({
      description:
        "Only on a re-ingestion: the cost and time estimate (p50 to p90) to show before the click.",
    }),
    repositories: z
      .array(
        z.object({
          repository: z.string(),
          sha: z.string().nullable(),
          runId: z.string().nullable(),
          status: z.enum(["pending", "done", "partial", "skipped", "failed"]),
          report: z.array(z.string()),
          spendUsd: z.number().nullable().openapi({
            description:
              "The model spend in USD of the ingestion runs of the repository in this upgrade, from the usage that their steps report. A run that starts again adds to it.",
          }),
          spendUnknown: z.boolean().openapi({
            description:
              "True when a model step of the run reported no usage: the spend is unknown, `spendUsd` is only the known part.",
          }),
        }),
      )
      .openapi({
        description:
          "Only on a re-ingestion: one entry for each source repository of the last run, in run order.",
      }),
    blockedReason: z
      .enum(Object.values(UPGRADE_BLOCKED_REASONS) as [string, ...string[]])
      .nullable()
      .openapi({
        description:
          "`write_access`: ctxpipe cannot write to the repository. `needs_format`: a re-ingestion needs format 3; merge the format upgrade first. `sandbox_unavailable`: this deployment has no ingest sandbox. `ingestion_v2_off`: ingestion v2 does not publish to this Workspace (its format is not read yet).",
      }),
    note: z.string().nullable(),
    waitingForSlot: z
      .object({ reason: z.string(), since: z.string().datetime() })
      .nullable()
      .openapi({
        description:
          "Only on a re-ingestion that waits for its turn to use a free sandbox slot: why it waits and when the wait began. `null` when it does not wait.",
      }),
    failureReason: z.string().nullable(),
    failure: z
      .object({
        code: z.enum(UPGRADE_FAILURE_CODES),
        step: z.enum(UPGRADE_FAILURE_STEPS).nullable(),
        repository: z.string().nullable(),
        summary: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "Only when `status` is `failed`: the class of the failure, the step that failed, and a short safe summary of the cause. `source_access`: ctxpipe cannot read a source repository. `workspace_write_access`: ctxpipe cannot write to the Workspace repository. `sandbox`: the ingest sandbox failed. `model`: a model or provider error. `publish_conflict`: the Workspace changed during the publish, and ctxpipe could not merge the files. `timeout`: a run or its turn took too long. `too_many_sources`: the Workspace has more source repositories than one run handles. `repository_too_large`: a Git repository is larger than ctxpipe can read in one step. `server_busy`: the server could not start a process, because it had too many processes or too little memory. `unknown`: no other class.",
      }),
    autoRetried: z.boolean().openapi({
      description:
        "True when a run of this upgrade failed for a temporary cause, and ctxpipe started it again by itself, once. The user did not start that second run. A start by the user sets it to false.",
    }),
    runStage: z
      .object({
        name: z.enum(UPGRADE_RUN_STAGES),
        since: z.string().datetime(),
      })
      .nullable()
      .openapi({
        description:
          "Only on a git upgrade while `status` is `running`: the stage of the run and when it began. The stages in order: `read` (ctxpipe reads the Workspace repository), `build` (ctxpipe makes the upgrade commits), `push` (ctxpipe pushes the upgrade branch), `open` (ctxpipe opens the pull request). `null` before the first stage, on a re-ingestion, and when the status is not `running`.",
      }),
    mergedAt: z.string().datetime().nullable().openapi({
      description:
        "Only on a git upgrade with an open pull request: when ctxpipe first saw that the pull request merged. After that, ctxpipe reads the new format of the repository, and a scan completes the upgrade.",
    }),
    checkedAt: z.string().datetime().nullable().openapi({
      description:
        "When the last scan checked this upgrade: the scan that Check again, a pull request webhook or a release starts. `null` before the first check of this version.",
    }),
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
        "The format of the Workspace repository that ctxpipe read last. `null`: not read yet. `-1`: the format file is not valid.",
    }),
    codeFormat: z.number().int().openapi({
      description:
        "The newest format that this ctxpipe version reads and writes.",
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
  const reingest = isReingestUpgradeKey(upgrade.key)
  const steps = reingest
    ? []
    : (upgrade.steps ??
      pendingUpgradeSteps(
        GIT_UPGRADE_STEPS,
        upgrade.fromFormat,
        Math.min(upgrade.targetFormat, GIT_UPGRADE_STEPS.length),
      ).map((step) => ({ ...step, sha: null, report: [], notices: [] })))
  return {
    key: upgrade.key,
    kind: reingest ? "reingest" : "format",
    title: reingest
      ? "Fresh re-ingestion of the source repositories"
      : `Upgrade to format ${upgrade.targetFormat}`,
    description: reingest
      ? REINGEST_DESCRIPTION
      : steps
          .map(
            (step) =>
              GIT_UPGRADE_STEPS.find(({ format }) => format === step.format)
                ?.description,
          )
          .filter(Boolean)
          .join(" "),
    status: row.status,
    fromFormat: upgrade.fromFormat,
    targetFormat: upgrade.targetFormat,
    steps: steps.map((step) => ({
      format: step.format,
      title: step.title,
      commitSha: step.sha,
      report: step.report,
      notices: step.notices ?? [],
    })),
    pullRequest: upgrade.prUrl
      ? { number: upgrade.prNumber ?? null, url: upgrade.prUrl }
      : null,
    estimate: upgrade.estimate ?? null,
    repositories: (upgrade.repositories ?? []).map((r) => ({
      ...r,
      spendUsd: r.spendUsd ?? null,
      spendUnknown: r.spendUnknown === true,
    })),
    blockedReason: upgrade.blockedReason ?? null,
    note: upgrade.note ?? null,
    waitingForSlot: upgrade.waitingForSlot ?? null,
    failureReason: row.failureReason,
    failure: classifyUpgradeFailure({
      status: row.status,
      failureReason: row.failureReason,
      repositories: upgrade.repositories,
    }),
    autoRetried: upgrade.autoRetry !== undefined,
    runStage:
      row.status === UPGRADE_STATUSES.running && upgrade.stage
        ? upgrade.stage
        : null,
    mergedAt: upgrade.mergedAt ?? null,
    checkedAt: upgrade.checkedAt ?? null,
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
            "The upgrade is queued. A git upgrade opens a pull request on the branch `ctxpipe/upgrade/<key>`; ctxpipe never pushes to the default branch. A re-ingestion runs ingestion v2 for each source repository, one Workspace of the org at a time.",
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

const checkUpgradesRoute = createRoute(
  directWriteRoute(
    {
      method: "post",
      path: "/{workspaceSlug}/upgrades/check",
      request: { params: WorkspaceSlugParamsSchema },
      responses: {
        202: {
          content: {
            "application/json": { schema: z.object({ queued: z.boolean() }) },
          },
          description:
            "ctxpipe reads the default branch of the Workspace repository now, the same tip check that a merge webhook starts, and checks the upgrades of the org again. `queued` is false when a check ran in the last minute: that check still writes its result.",
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
    },
    { orgAdmin: true },
  ),
)

const automaticUpgradesRoute = createRoute(
  directWriteRoute(
    {
      method: "post",
      path: "/{workspaceSlug}/upgrades/automatic",
      request: {
        params: WorkspaceSlugParamsSchema,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                mode: UpgradeModeSchema.openapi({
                  description:
                    "`automatic`: the upgrade scan starts each upgrade of this Workspace with no click. `manual`: an owner or admin starts each upgrade.",
                }),
              }),
            },
          },
        },
      },
      responses: {
        202: {
          content: {
            "application/json": {
              schema: z.object({
                queued: z.literal(true),
                jobId: z.string().openapi({
                  description:
                    "The file job that commits the setting. Read its status at `GET /{workspaceSlug}/files/jobs/{jobId}`. A job whose run ended with an error is `failed`, with the cause in `failureReason`.",
                }),
              }),
            },
          },
          description:
            "Automatic upgrades on or off: ctxpipe commits `upgrades: <mode>` into `.ctxpipe/workspace.yaml` on the default branch of the Workspace repository. With `automatic`, the upgrade scan starts each upgrade of this Workspace with no click. A merge of a git upgrade pull request still needs a person. When the job is done, ctxpipe starts the waiting upgrades of the Workspace itself, so that their pull request contains the setting. The caller sends no second request and need not wait for the job.",
        },
        401: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "Unauthorized",
        },
        404: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "Not found",
        },
        409: {
          content: { "application/json": { schema: ErrorResponseSchema } },
          description: "ctxpipe cannot write to the Workspace repository now",
        },
      },
    },
    { orgAdmin: true },
  ),
)

const upgradeModeRoute = createRoute({
  method: "get",
  path: "/{workspaceSlug}/upgrades/automatic",
  request: { params: WorkspaceSlugParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            mode: UpgradeModeSchema.nullable().openapi({
              description:
                "The `upgrades` setting of `.ctxpipe/workspace.yaml` at the tip that ctxpipe read last. No key is `manual`. `null`: ctxpipe has read no tip, or the format file is not valid.",
            }),
          }),
        },
      },
      description:
        "The automatic-upgrades setting of the Workspace. ctxpipe reads it from git on each request, so do not poll it.",
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

const routes = new OpenAPIHono<AppEnv>()
  .openapi(listUpgradesRoute, async (c) => {
    if (!c.get("user") || !c.get("session"))
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    // A read writes nothing. The tip check sets a stopped run to `failed`,
    // and the scan and the slot poll cancel orphaned re-ingestion runs.
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
  .openapi(checkUpgradesRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    // The tip check reads every Workspace of the org. Start one each minute.
    const minute = Math.floor(Date.now() / 60_000)
    const queued = await enqueueWorkspaceTipCheck(orgId, c.get("log"), {
      idempotencyKey: `tip-check-on-demand:${orgId}:${minute}`,
    })
    // A blocked item can clear without a new tip or release: for example,
    // this deployment can now run the ingest sandbox. Scan the org again.
    await enqueueWorkspaceUpgradeScan({ orgId, trigger: `check:${minute}` })
    return c.json({ queued }, 202)
  })
  .openapi(upgradeModeRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    return c.json(
      { mode: await readUpgradeMode(orgId, workspace, c.var.env) },
      200,
    )
  })
  .openapi(automaticUpgradesRoute, async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const { workspaceSlug } = c.req.valid("param")
    const workspace = await getWorkspaceBySlug(workspaceSlug)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    const jobId = generateObjectId("wjob")
    const { mode } = c.req.valid("json")
    const admitted = await setUpgradeMode(
      { jobId, orgId, workspace, mode },
      c.get("log"),
    )
    if (!admitted.started)
      return c.json(
        {
          error:
            "ctxpipe could not save the setting. Refresh the Workspace and try again.",
        },
        409,
      )
    return c.json({ queued: true as const, jobId }, 202)
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
 * key. Each upgrade needs its own click, unless an owner or admin turned on
 * Always update for the Workspace; there is no org-wide approval.
 */
const gated = new OpenAPIHono<AppEnv>()
gated.use("/:workspaceSlug/upgrades/:key/start", requireOrgAdminOrOwner)
gated.use("/:workspaceSlug/upgrades/check", requireOrgAdminOrOwner)
// A member may read the setting. Only an owner or admin may change it.
gated.post("/:workspaceSlug/upgrades/automatic", requireOrgAdminOrOwner)
export const workspaceUpgradeRoutes = gated.route("/", routes)

const PendingWorkspaceUpgradesSchema = z
  .object({
    workspaces: z.array(
      z.object({
        workspaceSlug: z.string(),
        formatVersion: z.number().int().nullable().openapi({
          description:
            "The format of the Workspace repository that ctxpipe read last. `null`: not read yet. `-1`: the format file is not valid.",
        }),
        codeFormat: z.number().int().openapi({
          description:
            "The newest format that this ctxpipe version reads and writes.",
        }),
        items: z.array(WorkspaceUpgradeItemSchema),
      }),
    ),
  })
  .openapi("PendingWorkspaceUpgrades")

const listPendingUpgradesRoute = createRoute({
  method: "get",
  path: "/pending",
  responses: {
    200: {
      content: {
        "application/json": { schema: PendingWorkspaceUpgradesSchema },
      },
      description:
        "The upgrades of the org that are not `completed`, grouped by Workspace. A Workspace below the newest format is also in the list, with no item when it has no upgrade row yet. Every other Workspace with no pending upgrade is not in the list. Every member can read them. The read writes nothing.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

/** One read of the pending upgrades of all the Workspaces of an org (the home alert). */
export const orgPendingUpgradeRoutes = new OpenAPIHono<AppEnv>().openapi(
  listPendingUpgradesRoute,
  async (c) => {
    const orgId = c.get("orgId")
    if (!c.get("user") || !c.get("session") || !orgId)
      return c.json({ error: "Unauthorized" }, 401)
    const bySlug = new Map<
      string,
      Array<z.infer<typeof WorkspaceUpgradeItemSchema>>
    >()
    for (const row of await listOrgPendingUpgradeRows()) {
      const items = bySlug.get(row.workspaceSlug) ?? []
      items.push(serializeUpgrade(row))
      bySlug.set(row.workspaceSlug, items)
    }
    // A Workspace below the newest format needs the format upgrade even when
    // the scan wrote no upgrade row for it yet, so the connect flows need it.
    const workspaces = (await listOrgWorkspaces(orgId))
      .filter(
        (workspace) =>
          bySlug.has(workspace.slug) ||
          (typeof workspace.formatVersion === "number" &&
            workspace.formatVersion >= 0 &&
            workspace.formatVersion < CODE_FORMAT),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug))
    return c.json(
      {
        workspaces: workspaces.map((workspace) => ({
          workspaceSlug: workspace.slug,
          formatVersion: workspace.formatVersion,
          codeFormat: CODE_FORMAT,
          items: bySlug.get(workspace.slug) ?? [],
        })),
      },
      200,
    )
  },
)
