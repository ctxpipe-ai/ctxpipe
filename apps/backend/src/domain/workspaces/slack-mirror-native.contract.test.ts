import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { encodeSlackBotTokenForDb } from "../../lib/connection-config.js"
import { upsertConnectionDirectory } from "../../models/connection-directory.js"
import { slackMentionAgent } from "../../openworkflow/workflows/slack-mention-agent.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

it.each([
  "bare",
  "intent",
  "capability",
  "child_failure",
  "child_failure_fallback",
] as const)(
  "handles Slack %s through durable intent and mirror steps before publishing status",
  { timeout: 45_000 },
  async (mode) => {
    const requests: Array<{ method: string; body: unknown }> = []
    await withNativeHydrationFixture(
      {
        slackCaptureIntent: mode === "intent",
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "knowledge/owner.md", body: "# Owner text\n" }],
        onSlackRequest: (method, body) => requests.push({ method, body }),
        slackResponses: {
          "chat.postMessage": { ok: true, ts: "1700000001.000000" },
          "chat.update":
            mode === "child_failure_fallback"
              ? { ok: false, error: "cant_update_message" }
              : { ok: true },
          "conversations.info": {
            ok: true,
            channel: { id: "C1", name: "engineering", is_private: false },
          },
          "conversations.replies": {
            ok: true,
            messages: [
              {
                ts: "1700000000.000000",
                text: "Keep this engineering decision.",
              },
              { ts: "1700000001.000000", text: "ctx| agent working…" },
            ],
          },
          "chat.getPermalink": {
            ok: true,
            permalink:
              "https://fixture.slack.com/archives/C1/p1700000000000000",
          },
        },
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const repo = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!repo) throw new Error("Fixture repository missing")
        const connectionId = `con_${f.id}_slack`
        const fixtureToken = "native-slack-fixture-token"
        const [connection] = await withOrgDbContext(f.org.id, (db) =>
          db
            .insert(connections)
            .values({
              id: connectionId,
              orgId: f.org.id,
              type: "slack",
              config: {
                botTokenEnc: encodeSlackBotTokenForDb(
                  fixtureToken,
                  parseEnv(process.env),
                ),
                teamId: "T1",
                teamName: "Fixture",
                botUserId: "B1",
                ownerUserId: "fixture-owner",
                status: "installed",
                repositoryId: repo.id,
                branch: "main",
                enabled: true,
              },
            })
            .returning(),
        )
        if (!connection) throw new Error("Fixture connection missing")
        await upsertConnectionDirectory(connection)
        f.runner.implementWorkflow(slackMentionAgent.spec, slackMentionAgent.fn)
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        if (mode.startsWith("child_failure"))
          f.onWriteCredentialRequest(async () => {
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(connections)
                .set({
                  config: sql`${connections.config} || '{"enabled":false}'::jsonb`,
                })
                .where(eq(connections.id, connectionId)),
            )
          })
        const worker = f.runner.newWorker({ concurrency: 1 })
        const handle = await f.runner.runWorkflow(slackMentionAgent.spec, {
          orgId: f.org.id,
          connectionId,
          channelId: "C1",
          threadTs: "1700000000.000000",
          mentionText:
            mode === "bare" || mode.startsWith("child_failure")
              ? "<@B1>"
              : mode === "intent"
                ? "<@B1> capture this"
                : "<@B1> hello",
        })
        try {
          await worker.start()
          await expect
            .poll(
              async () =>
                (
                  await f.backend.listStepAttempts({
                    workflowRunId: handle.workflowRun.id,
                  })
                ).data.some((attempt) => attempt.status === "completed"),
              { timeout: 5_000 },
            )
            .toBe(true)
          if (mode.startsWith("child_failure")) {
            await expect(handle.result({ timeoutMs: 20_000 })).rejects.toThrow()
            expect(
              (
                await f.backend.getWorkflowRun({
                  workflowRunId: handle.workflowRun.id,
                })
              )?.status,
            ).toBe("failed")
            expect(
              requests.filter((r) => r.method === "chat.update"),
            ).toMatchObject([
              {
                body: {
                  text: expect.stringContaining(
                    "Engineering context capture failed.",
                  ),
                },
              },
            ])
            if (mode === "child_failure_fallback")
              expect(
                requests.filter((r) => r.method === "chat.postMessage"),
              ).toMatchObject([
                { body: { text: "ctx| agent working…" } },
                {
                  body: {
                    text: expect.stringContaining(
                      "Engineering context capture failed.",
                    ),
                  },
                },
              ])
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }
          const result = await handle.result({ timeoutMs: 20_000 })
          if (mode === "capability") {
            expect(result).toEqual({ kind: "capability" })
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            expect(
              (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
                (run) =>
                  run.workflowName === "workspace-write-connector-mirror",
              ),
            ).toHaveLength(0)
            expect(
              requests.filter((r) => r.method === "chat.update"),
            ).toMatchObject([
              {
                body: {
                  text: "I can capture this thread into your context repo. Ask me to capture it, or mention me with no extra text.",
                },
              },
            ])
            return
          }
          expect(result).toMatchObject({
            kind: "captured",
            capture: { status: "completed", messageCount: 1 },
          })
          const runs = (await f.backend.listWorkflowRuns({ limit: 100 })).data
          expect(
            runs.filter(
              (run) => run.workflowName === "workspace-write-connector-mirror",
            ),
          ).toMatchObject([
            {
              status: "completed",
              input: {
                mirror: {
                  provider: "slack",
                  connectionId,
                  repositoryId: repo.id,
                },
              },
            },
          ])
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--count",
              `${f.sha}..main`,
            ),
          ).toBe("1")
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
            ),
          ).toBe(
            "knowledge/owner.md\nslack/channels/engineering--C1/index.md\nslack/channels/engineering--C1/threads/2023/11/1700000000.000000/index.md",
          )
          const markdown = f.git(
            "--git-dir",
            f.remote,
            "show",
            "main:slack/channels/engineering--C1/threads/2023/11/1700000000.000000/index.md",
          )
          expect(markdown).toContain("Keep this engineering decision.")
          expect(markdown).not.toContain("ctx| agent working")
          expect(
            requests.filter((r) => r.method === "chat.update"),
          ).toMatchObject([
            {
              body: {
                text: expect.stringContaining("Engineering context captured."),
              },
            },
          ])
          for (const run of runs) {
            expect(JSON.stringify(run.input)).not.toContain(fixtureToken)
            expect(
              JSON.stringify(
                (await f.backend.listStepAttempts({ workflowRunId: run.id }))
                  .data,
              ),
            ).not.toContain(fixtureToken)
          }
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 100 }))
            .data)
            if (!["completed", "failed", "canceled"].includes(run.status))
              await f.runner.cancelWorkflowRun(run.id)
          await worker.stop()
        }
      },
    )
  },
)
