import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { conversationSessionBranch } from "../../domain/workspaces/chat-lifecycle.js"
import { shellSingleQuote } from "../../domain/workspaces/conversation-publish.js"
import { warmTanstackWorkspaceChat } from "../../domain/workspaces/tanstack-workspace-chat.js"
import { getConversation } from "../../models/conversations.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { conversationRoutes } from "./conversations.js"

it.each([
  "push",
  "sha_before_push",
  "other_revision_heartbeat",
  "warm_files",
  "provider_unavailable",
  "provider_unavailable_push",
  "pull-request",
  "pr_collision",
  "missing",
  "stale",
  "stale_push",
  "stale_connection",
  "stale_generation",
  "stale_sha",
  "stale_default_branch",
  "relink_after_push",
  "relink_after_push_push",
  "relink_during_pr",
  "relink_before_pr",
])(
  "publishes from the authenticated conversation HTTP boundary: %s",
  { timeout: 60_000 },
  async (scenario) => {
    const pullRequests: unknown[] = []
    let relink: (() => Promise<void>) | undefined
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        ...(scenario === "pr_collision"
          ? {
              githubPullRequest: {
                number: 42,
                head: { ref: "unrelated-feature" },
                state: "open",
                html_url:
                  "https://github.com/fixture/hydration-contract/pull/42",
              },
            }
          : {}),
        onGithubPrCredential: async () => {
          if (scenario === "relink_before_pr") await relink?.()
        },
        onGithubPullRequest: async (body) => {
          pullRequests.push(body)
          if (scenario === "relink_during_pr") await relink?.()
        },
      },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        const published = join(f.directory, "conversation-published")
        const release = join(f.directory, "conversation-publish-release")
        relink = async () => {
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(workspaces)
              .set({ desiredGeneration: f.revision.generation + 1 })
              .where(eq(workspaces.id, f.workspaceId)),
          )
        }
        const previousProvider = process.env.SANDBOX_PROVIDER
        process.env.SANDBOX_PROVIDER = "unsandboxed"
        let raw = await localProcessSandbox().create({ id: conversationId })
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              userId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              name: "Chat changes",
            }),
          )
          if (scenario === "pr_collision") {
            const { withUserIdContext } = await import("../../auth/context.js")
            const { persistConversationPublication } = await import(
              "../../models/conversations.js"
            )
            await withOrgIdContext(f.org, () =>
              withUserIdContext(userId, () =>
                persistConversationPublication({
                  conversationId,
                  lastBranch: conversationSessionBranch(conversationId),
                  lastChatPrNumber: 42,
                  revision: f.revision,
                }),
              ),
            )
            await relink()
          }
          if (scenario !== "missing" && scenario !== "warm_files") {
            const warmed = await withOrgIdContext(f.org, () =>
              withTestLogger(() =>
                warmTanstackWorkspaceChat({
                  conversationId,
                  orgId: f.org.id,
                  orgSlug: f.org.slug,
                  workspaceId: f.workspaceId,
                  desiredUrl: f.workspaceUrl,
                  desiredSha: f.sha,
                  desiredGeneration:
                    f.revision.generation +
                    (scenario === "pr_collision" ? 1 : 0),
                  githubConnectionId: f.connectionId,
                  defaultBranch: "main",
                  lastBranch: conversationSessionBranch(conversationId),
                  writeStatus: "writable",
                  prompt: "prepare",
                  cloneToken: "fixture-native-clone",
                }),
              ),
            )
            if (!warmed.ok) throw new Error(warmed.error)
            await raw.destroy()
            raw = warmed.handle
          }
          await raw.process.exec("git init -b main")
          await raw.process.exec(`git fetch ${shellSingleQuote(f.remote)} main`)
          await raw.process.exec("git checkout -B main FETCH_HEAD")
          await raw.fs.write("notes.md", "# Saved conversation\n")
          if (scenario !== "missing" && scenario !== "warm_files") {
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaceSandboxInstances)
                .set({
                  revision: {
                    ...f.revision,
                    access: "read",
                    remote: {
                      url:
                        scenario === "stale" || scenario === "stale_push"
                          ? "https://github.com/fixture/other"
                          : f.workspaceUrl,
                      connectionId:
                        scenario === "stale_connection"
                          ? "con_other"
                          : f.connectionId,
                    },
                    sha: scenario === "stale_sha" ? "0".repeat(40) : f.sha,
                    generation:
                      f.revision.generation +
                      (scenario === "stale_generation" ||
                      scenario === "pr_collision"
                        ? 1
                        : 0),
                    defaultBranch:
                      scenario === "stale_default_branch" ? "other" : "main",
                  },
                })
                .where(
                  eq(workspaceSandboxInstances.conversationId, conversationId),
                ),
            )
          }
          if (scenario === "sha_before_push") {
            f.onWriteCredentialRequest(async () => {
              await withOrgDbContext(f.org.id, (db) =>
                db
                  .update(workspaces)
                  .set({ desiredSha: "f".repeat(40) })
                  .where(eq(workspaces.id, f.workspaceId)),
              )
            })
          }
          if (scenario === "other_revision_heartbeat") {
            const other = await withOrgIdContext(f.org, () =>
              withTestLogger(() =>
                warmTanstackWorkspaceChat({
                  conversationId,
                  orgId: f.org.id,
                  orgSlug: f.org.slug,
                  workspaceId: f.workspaceId,
                  desiredUrl: f.workspaceUrl,
                  desiredSha: f.sha,
                  desiredGeneration: f.revision.generation + 1,
                  githubConnectionId: f.connectionId,
                  defaultBranch: "main",
                  writeStatus: "writable",
                  lastBranch: conversationSessionBranch(conversationId),
                  prompt: "prepare",
                  cloneToken: "fixture-native-clone",
                }),
              ),
            )
            if (!other.ok) throw new Error(other.error)
            expect(other.handle.id).not.toBe(raw.id)
          }
          if (scenario.startsWith("relink_after_push")) {
            await raw.fs.write(
              ".git/hooks/reference-transaction",
              `#!/bin/sh
if [ "$1" = committed ]; then
  while read old new ref; do
    case "$ref" in refs/remotes/origin/ctxpipe/chat/*)
      touch ${shellSingleQuote(published)}
      for retry in $(seq 1 750); do
        [ -f ${shellSingleQuote(release)} ] && break
        sleep 0.02
      done
    esac
  done
fi
`,
            )
            await raw.process.exec("chmod 700 .git/hooks/reference-transaction")
          }
          const app = new OpenAPIHono<AppEnv>()
          app.use(contextStorage())
          app.use(withTestRequestLogger)
          app.use("*", async (c, next) => {
            c.set("user", { id: userId } as AppEnv["Variables"]["user"])
            c.set("session", {
              id: `sess_${f.id}`,
            } as AppEnv["Variables"]["session"])
            await withOrgIdContext(f.org, next)
          })
          app.route("/conversations", conversationRoutes)
          if (scenario === "pr_collision")
            expect(
              (
                await app.request(
                  `/conversations/${conversationId}/pull-request`,
                )
              ).status,
            ).toBe(404)
          if (scenario === "warm_files") {
            const saved = await app.request(
              `/conversations/${conversationId}/files/blob`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  path: "notes.md",
                  body: "# Saved conversation\n",
                  expectedWorktreeVersion: (
                    (await (
                      await app.request(
                        `/conversations/${conversationId}/files/tree`,
                      )
                    ).json()) as { worktreeVersion?: string }
                  ).worktreeVersion,
                }),
              },
            )
            expect({
              status: saved.status,
              body: await saved.json(),
            }).toMatchObject({ status: 200 })
          }
          if (scenario.startsWith("provider_unavailable")) {
            process.env.SANDBOX_PROVIDER = "railway"
            if (scenario === "provider_unavailable") {
              for (const path of [
                "tree",
                "blob?path=notes.md",
                "status",
                "diff",
              ]) {
                const failed = await app.request(
                  `/conversations/${conversationId}/files/${path}`,
                )
                expect({
                  status: failed.status,
                  body: await failed.json(),
                }).toEqual({
                  status: 503,
                  body: {
                    error: "TanStack sandbox provider railway is not available",
                  },
                })
              }
              const failedSave = await app.request(
                `/conversations/${conversationId}/files/blob`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    path: "notes.md",
                    body: "must not be saved",
                    expectedWorktreeVersion: "wt-ignored",
                  }),
                },
              )
              expect(failedSave.status).toBe(503)
              expect(await raw.fs.read("notes.md")).toBe(
                "# Saved conversation\n",
              )
            }
          }
          const pendingResponse = app.request(
            `/conversations/${conversationId}/${scenario === "push" || scenario === "provider_unavailable_push" || scenario === "warm_files" || scenario === "stale_push" || scenario === "relink_after_push_push" ? "push" : "pull-request"}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Chat changes" }),
            },
          )
          if (scenario.startsWith("relink_after_push")) {
            try {
              await expect
                .poll(() => existsSync(published), { timeout: 10_000 })
                .toBe(true)
              await relink()
            } finally {
              writeFileSync(release, "release")
            }
          }
          const response = await pendingResponse
          const body = await response.json()
          const branch = conversationSessionBranch(conversationId)
          if (scenario.startsWith("provider_unavailable")) {
            expect({ status: response.status, body }).toEqual({
              status: 503,
              body: {
                error: "TanStack sandbox provider railway is not available",
              },
            })
            expect(pullRequests).toEqual([])
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe("1")
          } else if (scenario === "sha_before_push") {
            expect({ status: response.status, body }).toEqual({
              status: 400,
              body: { error: "Conversation write binding changed before push" },
            })
            expect(pullRequests).toEqual([])
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe("1")
          } else if (scenario.startsWith("relink_")) {
            expect({ status: response.status, body }).toEqual({
              status: 409,
              body: { error: "stale_binding" },
            })
            expect(pullRequests).toHaveLength(
              scenario === "relink_during_pr" ? 1 : 0,
            )
            const { withUserIdContext } = await import("../../auth/context.js")
            expect(
              await withOrgIdContext(f.org, () =>
                withUserIdContext(userId, () =>
                  getConversation(conversationId),
                ),
              ),
            ).toMatchObject({ lastChatPrNumber: null, lastBranch: null })
          } else if (scenario === "missing" || scenario.startsWith("stale")) {
            expect({ status: response.status, body }).toEqual({
              status: scenario === "missing" ? 409 : 400,
              body: {
                error:
                  scenario === "missing"
                    ? "missing_sandbox"
                    : scenario === "stale" || scenario === "stale_push"
                      ? "stale_url"
                      : scenario,
              },
            })
            expect(pullRequests).toEqual([])
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe("1")
          } else {
            expect(response.status).toBe(200)
            expect(body).toMatchObject({ branch })
            expect(
              f.git("--git-dir", f.remote, "show", `${branch}:notes.md`),
            ).toBe("# Saved conversation")
            if (scenario === "pull-request" || scenario === "pr_collision") {
              expect(body).toMatchObject({
                prNumber: 41,
                pullUrl:
                  "https://github.com/fixture/hydration-contract/pull/41",
                prState: "open",
              })
              expect(pullRequests).toEqual([
                expect.objectContaining({
                  head: branch,
                  base: "main",
                  title: "Chat changes",
                }),
              ])
              const { withUserIdContext } = await import(
                "../../auth/context.js"
              )
              expect(
                await withOrgIdContext(f.org, () =>
                  withUserIdContext(userId, () =>
                    getConversation(conversationId),
                  ),
                ),
              ).toMatchObject({ lastBranch: branch, lastChatPrNumber: 41 })
            }
          }
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        } finally {
          {
            const { listSandboxInstances, deleteSandboxInstance } =
              await import("../../models/workspaces.js")
            const { destroyDetachedProviderSandbox } = await import(
              "../../domain/workspaces/sandbox-provider.js"
            )
            const instances = await withOrgDbContext(f.org.id, () =>
              listSandboxInstances({ conversationId, kind: "chat" }),
            )
            for (const instance of instances) {
              if (instance.providerSandboxId)
                await destroyDetachedProviderSandbox({
                  provider: instance.provider,
                  providerSandboxId: instance.providerSandboxId,
                })
              await deleteSandboxInstance(instance.id, f.org.id)
            }
          }
          if (previousProvider === undefined)
            delete process.env.SANDBOX_PROVIDER
          else process.env.SANDBOX_PROVIDER = previousProvider
          await raw.destroy()
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(conversations)
              .where(eq(conversations.id, conversationId)),
          )
        }
      },
    )
  },
)

it(
  "hides a saved PR when its workspace relinks during the provider read",
  { timeout: 30_000 },
  async () => {
    let relink: (() => Promise<void>) | undefined
    const pull = {
      number: 42,
      head: { ref: "" },
      state: "open",
      html_url: "https://github.com/fixture/hydration-contract/pull/42",
    }
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubPullRequest: pull,
        onGithubPullRequestRead: async () => relink?.(),
      },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const userId = `user_${f.id}`
        pull.head.ref = conversationSessionBranch(conversationId)
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(conversations).values({
            id: conversationId,
            userId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            source: "ui",
            lastMessageAt: new Date(),
            lastBranch: pull.head.ref,
            lastChatPrNumber: 42,
            lastChatPrRevision: f.revision,
          }),
        )
        const app = new OpenAPIHono<AppEnv>()
        app.use(contextStorage())
        app.use(withTestRequestLogger)
        app.use("*", async (c, next) => {
          c.set("user", { id: userId } as AppEnv["Variables"]["user"])
          c.set("session", {
            id: `sess_${f.id}`,
          } as AppEnv["Variables"]["session"])
          await withOrgIdContext(f.org, next)
        })
        app.route("/conversations", conversationRoutes)
        try {
          const listed = await (
            await app.request(`/conversations?workspaceId=${f.workspaceId}`)
          ).json()
          expect(listed.items[0]).toMatchObject({
            lastChatPrNumber: 42,
            lastChatPrUrl: pull.html_url,
          })
          expect(listed.items[0]).not.toHaveProperty("lastChatPrRevision")
          expect(
            (await app.request(`/conversations/${conversationId}/pull-request`))
              .status,
          ).toBe(200)
          relink = async () => {
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaces)
                .set({ desiredGeneration: f.revision.generation + 1 })
                .where(eq(workspaces.id, f.workspaceId)),
            )
          }
          expect(
            (await app.request(`/conversations/${conversationId}/pull-request`))
              .status,
          ).toBe(404)
          const after = await (
            await app.request(`/conversations?workspaceId=${f.workspaceId}`)
          ).json()
          expect(after.items[0]).toMatchObject({
            lastChatPrNumber: null,
            lastChatPrUrl: null,
          })
        } finally {
          await withOrgDbContext(f.org.id, (db) =>
            db
              .delete(conversations)
              .where(eq(conversations.id, conversationId)),
          )
        }
      },
    )
  },
)
