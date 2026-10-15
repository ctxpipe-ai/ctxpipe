import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  readWorkspaceBlobs,
  writeWorkspaceSlice,
} from "../../domain/workspace-sources/write-slice.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getSlackBindingWithRepoByConnectionId,
  getSlackConnectionByConnectionId,
} from "../../models/slack-connector.js"
import { getSlackMentionMirrorFailure } from "../../models/slack-mention-workflow.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  postSlackThreadMessage,
  SLACK_MENTION_STATUS_WORKING,
} from "../../services/slack/client.js"
import {
  formatSlackMentionStatusText,
  type SlackMentionAgentResult,
  selectSlackMentionIntent,
  slackCaptureWorkspaceLinks,
} from "../../services/slack/mention-agent.js"
import { publishSlackMentionStatus } from "../../services/slack/mention-status.js"
import { captureSlackThreadToSources } from "../../services/slack/source-adapter.js"
import {
  captureSlackThreadFiles,
  githubBlobUrl,
} from "../../services/slack/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const slackMentionAgentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  mentionText: z.string().optional(),
  mentionUserId: z.string().optional(),
})

export const slackMentionAgent = defineWorkflow(
  { name: "slack-mention-agent", schema: slackMentionAgentInputSchema },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "slack-mention-agent",
        connectionId: input.connectionId,
      }),
      async () => {
        const env = parseEnv(process.env)
        const context = await step.run(
          { name: "capture-slack-target" },
          async () => {
            const connection = await withOrgDbContext(input.orgId, () =>
              getSlackConnectionByConnectionId(input.orgId, input.connectionId),
            )
            if (connection?.status !== "installed")
              throw new Error("Slack connector is not live for this connection")
            // The repository binding from before ADR-050. The migration
            // turns it off, and then only the Workspace sources get captures.
            const target = await getSlackBindingWithRepoByConnectionId(
              input.orgId,
              input.connectionId,
            )
            const legacy = target?.enabled
              ? {
                  captured: await captureConnectorMirrorTarget({
                    orgId: input.orgId,
                    env,
                    repositoryGitUrl: target.repositoryGitUrl,
                    mirror: {
                      provider: "slack",
                      connectionId: input.connectionId,
                      repositoryId: target.repositoryId,
                    },
                  }),
                  repositoryName: target.repositoryName,
                }
              : null
            return { teamId: connection.teamId, legacy }
          },
        )
        const freshConnection = async () => {
          const connection = await withOrgDbContext(input.orgId, () =>
            getSlackConnectionByConnectionId(input.orgId, input.connectionId),
          )
          if (
            connection?.status !== "installed" ||
            connection.teamId !== context.teamId
          )
            throw new Error("Slack authorization changed")
          return connection
        }
        const statusMessage = await step.run(
          { name: "post-working-status" },
          async () =>
            postSlackThreadMessage({
              env,
              connection: await freshConnection(),
              channelId: input.channelId,
              threadTs: input.threadTs,
              text: SLACK_MENTION_STATUS_WORKING,
            }),
        )
        const intent = await step.run({ name: "select-capture-intent" }, () =>
          selectSlackMentionIntent({
            env,
            connectionId: input.connectionId,
            mentionText: input.mentionText,
          }),
        )
        let outcome: SlackMentionAgentResult
        if (intent.kind === "capture") {
          const thread = {
            channelId: input.channelId,
            threadTs: input.threadTs,
            excludeMessageTs: statusMessage?.ts,
            capturedByUserId: input.mentionUserId,
            capturedAt: run.createdAt.toISOString(),
          }
          const sources = await step.run(
            { name: "capture-slack-thread-to-sources" },
            async () =>
              captureSlackThreadToSources({
                ...thread,
                orgId: input.orgId,
                env,
                connection: await freshConnection(),
                write: async (slice) => {
                  await writeWorkspaceSlice(slice, env)
                },
                readExisting: (workspaceId) =>
                  readWorkspaceBlobs({
                    orgId: input.orgId,
                    workspaceId,
                    env,
                  }),
              }),
          )
          const threadPath =
            sources.kind === "captured" ? sources.capture.threadPath : undefined
          const workspaces =
            sources.kind === "captured" && threadPath
              ? await step.run({ name: "link-captured-workspaces" }, () =>
                  slackCaptureWorkspaceLinks({
                    orgId: input.orgId,
                    workspaceIds: sources.workspaces,
                    threadPath,
                    env,
                  }),
                )
              : []
          const legacy = context.legacy
          // The old capture into the bound repository, until the migration
          // turns the binding off.
          const captureToLegacyRepository = async (
            target: NonNullable<typeof legacy>,
          ): Promise<SlackMentionAgentResult> => {
            const captured = await step.run(
              { name: "capture-slack-thread" },
              async () =>
                captureSlackThreadFiles({
                  ...thread,
                  env,
                  connection: await freshConnection(),
                }),
            )
            if (captured.status === "failed")
              return {
                kind: "failed",
                errorCode: captured.errorCode,
                error: captured.error,
              }
            const result = await step
              .runWorkflow(
                workspaceConnectorMirror.spec,
                {
                  orgId: input.orgId,
                  workspaceId: target.captured.workspaceId,
                  revision: target.captured.revision,
                  mirror: target.captured.mirror,
                  jobId: `wjob_${run.id}_mirror`,
                  files: captured.files,
                  deletePaths: [],
                },
                { name: "commit-slack-mirror" },
              )
              .catch(async (error) => {
                if (isWorkflowControlSignal(error)) throw error
                const failure = await getSlackMentionMirrorFailure({
                  orgId: input.orgId,
                  connectionId: input.connectionId,
                  workflowRunId: run.id,
                })
                if (!failure) throw error
                return { failed: true as const, error: failure }
              })
            if ("failed" in result)
              return { kind: "failed", error: result.error }
            const {
              files: _files,
              deletePaths: _deletes,
              ...capture
            } = captured
            return {
              kind: "captured",
              workspaces,
              capture: {
                ...capture,
                commitSha: result.commitSha,
                githubUrl: capture.threadPath
                  ? githubBlobUrl({
                      repositoryName: target.repositoryName,
                      ref:
                        result.commitSha ??
                        target.captured.revision.defaultBranch,
                      path: capture.threadPath,
                    })
                  : undefined,
              },
            }
          }
          if (
            sources.kind === "captured" &&
            sources.capture.status === "failed"
          )
            outcome = {
              kind: "failed",
              errorCode: sources.capture.errorCode,
              error: sources.capture.error,
            }
          else if (
            legacy &&
            !(
              sources.kind === "captured" &&
              sources.workspaces.includes(legacy.captured.workspaceId)
            )
          )
            outcome = await captureToLegacyRepository(legacy)
          else if (sources.kind === "captured")
            outcome = {
              kind: "captured",
              capture: sources.capture,
              workspaces,
            }
          else outcome = { kind: "failed", errorCode: "no_source" }
        } else outcome = intent
        await step.run({ name: "publish-capture-status" }, async () => {
          const published = await publishSlackMentionStatus({
            env,
            connection: await freshConnection(),
            channelId: input.channelId,
            threadTs: input.threadTs,
            text: formatSlackMentionStatusText(outcome),
            messageTs: statusMessage?.ts,
          })
          if (!published)
            throw new Error("Slack capture status could not be published")
        })
        if (outcome.kind === "failed" && outcome.errorCode !== "no_source")
          throw new Error(outcome.error ?? "Slack mention agent failed")
        return outcome
      },
    ),
)
