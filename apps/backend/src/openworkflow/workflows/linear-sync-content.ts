import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  activateConnectorSync,
  assertConnectorContentSyncBinding,
  connectorContentBindingSchema,
} from "../../models/connector-content-sync.js"
import {
  finalizeLinearBindingAfterContentWorkflow,
  getLinearBindingWithRepoByConnectionId,
  getLinearConnectionByConnectionId,
  refreshLinearConnectionTokensWithLock,
} from "../../models/linear-connector.js"
import { getLinearOauthAppCreds } from "../../models/linear-oauth-app.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import {
  linearTokenExpiresAt,
  refreshLinearOAuthToken,
} from "../../services/linear/client.js"
import { parseLinearConfigYamlContent } from "../../services/linear/config-yaml.js"
import {
  collectLinearMirrorPages,
  fetchLinearMirrorPage,
  walkLinearMirrorPages,
} from "../../services/linear/content.js"
import { captureLinearContent } from "../../services/linear/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const LinearSyncContentInputSchema = z.object({
  contentSyncBinding: connectorContentBindingSchema.optional(),
  configKey: z.string().optional(),
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  contentSyncGeneration: z.number().int().nonnegative().default(0),
})

export const linearSyncContent = defineWorkflow(
  {
    name: "linear-sync-content",
    schema: LinearSyncContentInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "linear-sync-content",
        orgId: input.orgId,
        connectionId: input.connectionId,
      }),
      async () => {
        if (
          !(await step.run({ name: "activate-content-sync" }, () =>
            activateConnectorSync({
              purpose: "content",
              orgId: input.orgId,
              connectionId: input.connectionId,
              workflowRunId: run.id,
            }),
          ))
        )
          return {
            status: "superseded" as const,
            written: 0,
            deleted: 0,
            failures: [],
          }
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const context = await step.run(
          { name: "load-linear-sync-context" },
          async () => {
            const target = await getLinearBindingWithRepoByConnectionId(
              input.orgId,
              input.connectionId,
            )
            if (!target?.githubConnectionId)
              throw new Error("Linear sync target is not configured")
            const connection = await withOrgDbContext(input.orgId, () =>
              getLinearConnectionByConnectionId(
                input.orgId,
                input.connectionId,
                env,
              ),
            )
            if (!connection) throw new Error("Linear connection not found")
            if (
              connection.status !== "installed" ||
              !target.enabled ||
              target.setupPhase !== "initial_sync"
            ) {
              throw new Error(
                "Linear sync target is not ready for initial sync",
              )
            }
            if (
              input.contentSyncBinding &&
              (target.repositoryId !== input.contentSyncBinding.repositoryId ||
                target.branch !== input.contentSyncBinding.branch ||
                connection.workspaceId !== input.contentSyncBinding.workspaceId)
            )
              throw new Error("Connector content target was superseded")
            await assertConnectorContentSyncBinding(input)
            const captured = await captureConnectorMirrorTarget({
              contentSyncGeneration: input.contentSyncGeneration ?? 0,
              repositoryGitUrl: target.repositoryGitUrl,
              orgId: input.orgId,
              env,
              mirror: {
                provider: "linear",
                connectionId: input.connectionId,
                repositoryId: target.repositoryId,
              },
            })
            const config = parseLinearConfigYamlContent(captured.config)
            if (!config) throw new Error("linear/config.yaml was not found")
            if (config.workspaceId !== connection.workspaceId)
              throw new Error(
                "linear/config.yaml workspace does not match the Linear connection",
              )
            return { target, captured, config }
          },
        )

        const onTokenRefresh = (
          expectedRefreshToken: string,
          expectedAccessToken: string,
        ) =>
          withOrgDbContext(input.orgId, () =>
            refreshLinearConnectionTokensWithLock({
              orgId: input.orgId,
              connectionId: input.connectionId,
              env,
              expectedRefreshToken,
              expectedAccessToken,
              refresh: async (refreshToken) => {
                const connection = await getLinearConnectionByConnectionId(
                  input.orgId,
                  input.connectionId,
                  env,
                )
                const creds = connection
                  ? getLinearOauthAppCreds(connection, env)
                  : undefined
                if (!creds) throw new Error("Linear OAuth is not configured")
                const token = await refreshLinearOAuthToken({
                  env,
                  refreshToken,
                  creds,
                })
                return {
                  accessToken: token.access_token,
                  refreshToken: token.refresh_token ?? refreshToken,
                  accessTokenExpiresAt: linearTokenExpiresAt(token.expires_in),
                }
              },
            }),
          )
        const loadAuthorizedConnection = async () => {
          const connection = await withOrgDbContext(input.orgId, () =>
            getLinearConnectionByConnectionId(
              input.orgId,
              input.connectionId,
              env,
            ),
          )
          if (
            !connection ||
            connection.status !== "installed" ||
            connection.workspaceId !== context.config.workspaceId
          )
            throw new Error("Linear authorization changed")
          return connection
        }
        // One durable step per page: a crash refetches only the unfinished page.
        const pages = await walkLinearMirrorPages({
          config: context.config,
          runPage: (name, request) =>
            step.run({ name }, async () =>
              fetchLinearMirrorPage({
                env,
                connection: await loadAuthorizedConnection(),
                config: context.config,
                onTokenRefresh,
                request,
              }),
            ),
        })
        const collected = collectLinearMirrorPages(pages)
        const captured = await step.run(
          { name: "capture-linear-content" },
          async () =>
            captureLinearContent({
              env,
              connection: await loadAuthorizedConnection(),
              files: collected.files,
              failures: collected.failures,
              existingPaths: context.captured.paths,
              onTokenRefresh,
            }),
        )
        if (
          captured.status !== "failed" &&
          (captured.files.length || captured.deletePaths.length)
        ) {
          await step.runWorkflow(
            workspaceConnectorMirror.spec,
            {
              orgId: input.orgId,
              workspaceId: context.captured.workspaceId,
              revision: context.captured.revision,
              mirror: context.captured.mirror,
              jobId: `wjob_${run.id}_mirror`,
              files: captured.files,
              deletePaths: captured.deletePaths,
            },
            { name: "commit-linear-mirror" },
          )
        }
        const result = {
          status: captured.status,
          written: captured.files.length,
          deleted: captured.deletePaths.length,
          failures: captured.failures,
        }

        if (result.status !== "failed") {
          await runConnectorRepositoryIngestionWorkflow(
            step,
            {
              repositoryId: context.target.repositoryId,
              orgId: input.orgId,
              targetBranch: context.target.branch,
              indexingReason: "Syncing Linear content",
            },
            {
              error: (error) =>
                getLogger().error(error, {
                  step: "linear-sync-content.ingestion",
                  connectionId: input.connectionId,
                }),
            },
          )
        }

        await step.run({ name: "finalize-linear-sync" }, () =>
          finalizeLinearBindingAfterContentWorkflow({
            connectionId: input.connectionId,
            workflowStatus: result.status,
            binding: {
              contentSyncGeneration:
                context.captured.contentSyncGeneration ??
                input.contentSyncGeneration ??
                0,
              repositoryId: context.target.repositoryId,
              revision: context.captured.revision,
              provider: {
                kind: "linear",
                workspaceId: context.config.workspaceId,
              },
            },
          }),
        )
        return result
      },
    ),
)
