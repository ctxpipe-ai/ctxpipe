import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getSlackBindingWithRepoByConnectionId,
  getSlackConnectionByConnectionId,
} from "../../models/slack-connector.js"
import {
  postSlackThreadMessage,
  SLACK_MENTION_STATUS_WORKING,
} from "../../services/slack/client.js"
import {
  formatSlackMentionStatusText,
  type SlackMentionAgentResult,
  selectSlackMentionIntent,
} from "../../services/slack/mention-agent.js"
import { publishSlackMentionStatus } from "../../services/slack/mention-status.js"
import {
  captureSlackThreadFiles,
  githubBlobUrl,
} from "../../services/slack/sync.js"
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
  async ({ input, step, run }) => {
    const env = parseEnv(process.env)
    const context = await step.run(
      { name: "capture-slack-target" },
      async () => {
        const target = await getSlackBindingWithRepoByConnectionId(
          input.orgId,
          input.connectionId,
        )
        const connection = await withOrgDbContext(input.orgId, () =>
          getSlackConnectionByConnectionId(input.orgId, input.connectionId),
        )
        if (!target?.enabled || connection?.status !== "installed")
          throw new Error("Slack connector is not live for this connection")
        const captured = await captureConnectorMirrorTarget({
          orgId: input.orgId,
          env,
          repositoryGitUrl: target.repositoryGitUrl,
          mirror: {
            provider: "slack",
            connectionId: input.connectionId,
            repositoryId: target.repositoryId,
          },
        })
        return {
          captured,
          teamId: connection.teamId,
          repositoryName: target.repositoryName,
        }
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
      const captured = await step.run(
        { name: "capture-slack-thread" },
        async () =>
          captureSlackThreadFiles({
            env,
            connection: await freshConnection(),
            channelId: input.channelId,
            threadTs: input.threadTs,
            excludeMessageTs: statusMessage?.ts,
            capturedByUserId: input.mentionUserId,
            capturedAt: run.createdAt.toISOString(),
          }),
      )
      if (captured.status === "failed")
        outcome = {
          kind: "failed",
          errorCode: captured.errorCode,
          error: captured.error,
        }
      else {
        const result = await step.runWorkflow(
          workspaceConnectorMirror.spec,
          {
            orgId: input.orgId,
            workspaceId: context.captured.workspaceId,
            revision: context.captured.revision,
            mirror: context.captured.mirror,
            jobId: `wjob_${run.id}_mirror`,
            files: captured.files,
            deletePaths: [],
          },
          { name: "commit-slack-mirror" },
        )
        const { files: _files, ...capture } = captured
        outcome = {
          kind: "captured",
          capture: {
            ...capture,
            commitSha: result.commitSha,
            githubUrl: capture.threadPath
              ? githubBlobUrl({
                  repositoryName: context.repositoryName,
                  ref:
                    result.commitSha ?? context.captured.revision.defaultBranch,
                  path: capture.threadPath,
                })
              : undefined,
          },
        }
      }
    } else outcome = intent
    await step.run({ name: "publish-capture-status" }, async () =>
      publishSlackMentionStatus({
        env,
        connection: await freshConnection(),
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: formatSlackMentionStatusText(outcome),
        messageTs: statusMessage?.ts,
      }),
    )
    if (outcome.kind === "failed")
      throw new Error(outcome.error ?? "Slack mention agent failed")
    return outcome
  },
)
