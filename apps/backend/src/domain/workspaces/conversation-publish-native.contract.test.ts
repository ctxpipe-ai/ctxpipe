import { randomBytes } from "node:crypto"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import type { NativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { conversationSessionBranch } from "./chat-lifecycle.js"
import {
  pushConversationSession,
  shellSingleQuote,
} from "./conversation-publish.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { WorkspaceRevision } from "./revision.js"

/** The conversation's sandbox record, as chat writes it when it creates one. */
async function recordSandbox(
  f: NativeHydrationFixture,
  conversationId: string,
  providerSandboxId: string,
  revision: WorkspaceRevision,
) {
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(workspaceSandboxInstances).values({
      id: `sandbox-${conversationId}`,
      kind: "chat",
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      conversationId,
      provider: "local-process",
      providerSandboxId,
      image: "local-process",
      revision: { ...revision, access: "read" },
      state: "live",
      lastHeartbeatAt: new Date(),
    }),
  )
}

it.each([
  "publish",
  "rebind",
  "default_changed",
  "session_advanced",
  "large_base",
])(
  "brokers conversation publishing without agent write credentials: %s",
  { timeout: 30_000 },
  async (scenario) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        ...(scenario === "large_base"
          ? {
              files: [
                {
                  path: "large.bin",
                  body: randomBytes(9 * 1024 * 1024).toString("base64"),
                },
              ],
            }
          : {}),
      },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const raw = await localProcessSandbox().create({ id: conversationId })
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              orgId: f.org.id,
              userId: `user_${f.id}`,
              workspaceId: f.workspaceId,
            }),
          )
          await raw.process.exec("git init -b main")
          await raw.process.exec(`git fetch ${shellSingleQuote(f.remote)} main`)
          await raw.process.exec("git checkout -B main FETCH_HEAD")
          await raw.fs.write("notes.md", "# Conversation edit\n")
          // Substitute the third-party GitHub transport, including the old tokenized URL.
          f.git(
            "config",
            "--file",
            process.env.GIT_CONFIG_GLOBAL ?? "missing",
            "--add",
            `url.${f.remote}.insteadOf`,
            "https://x-access-token:fixture-only-github-write-token@github.com/fixture/hydration-contract.git",
          )
          await raw.fs.write(
            ".git/hooks/pre-push",
            '#!/bin/sh\nprintf "%s\\n%s\\n" "$1" "$2" > .git/agent-observed-push\n',
          )
          await raw.process.exec("chmod 700 .git/hooks/pre-push")
          await recordSandbox(f, conversationId, raw.id, f.revision)
          const request = {
            handle: adaptTanstackHandle(raw),
            conversationId,
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            env: parseEnv(process.env),
            commit: { subject: "Publish conversation edit" },
          }
          const branch = conversationSessionBranch(conversationId)
          f.onWriteCredentialRequest(async () => {
            if (scenario === "rebind")
              await withOrgDbContext(f.org.id, (db) =>
                db
                  .update(workspaces)
                  .set({ desiredGeneration: f.revision.generation + 1 })
                  .where(eq(workspaces.id, f.workspaceId)),
              )
            if (
              scenario === "default_changed" ||
              scenario === "session_advanced"
            ) {
              f.git(
                "--git-dir",
                f.remote,
                "update-ref",
                `refs/heads/${branch}`,
                f.sha,
              )
              if (scenario === "default_changed")
                f.git(
                  "--git-dir",
                  f.remote,
                  "symbolic-ref",
                  "HEAD",
                  `refs/heads/${branch}`,
                )
            }
          })
          const result = await withOrgIdContext(f.org, () =>
            withUserIdContext(`user_${f.id}`, () =>
              pushConversationSession(request),
            ),
          )
          if (scenario === "publish" || scenario === "large_base") {
            expect(result).toEqual({
              status: "pushed",
              branch,
              sha: expect.any(String),
            })
            expect(
              f.git("--git-dir", f.remote, "show", `${branch}:notes.md`),
            ).toBe("# Conversation edit")
          } else {
            expect(result).toEqual(
              scenario === "session_advanced"
                ? { status: "failed", reason: "push_failed" }
                : { status: "skipped", reason: "stale_binding" },
            )
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe("1")
          }
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
          const observed = await raw.process.exec(
            "test ! -f .git/agent-observed-push || cat .git/agent-observed-push",
          )
          expect(observed.stdout).not.toContain(
            "fixture-only-github-write-token",
          )
          expect(
            f.tokenRequests.filter(
              (request) =>
                (request as { permissions?: { contents?: string } }).permissions
                  ?.contents === "write",
            ),
          ).toEqual([
            {
              repositories: ["hydration-contract"],
              permissions: { contents: "write", metadata: "read" },
            },
          ])
        } finally {
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

it.each(["unchanged", "edited", "rebased"])(
  "publishes a restored shallow session branch: %s",
  { timeout: 30_000 },
  async (mode) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const conversationId = `conv_${f.id}`
        const branch = conversationSessionBranch(conversationId)
        const raw = await localProcessSandbox().create({ id: conversationId })
        try {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(conversations).values({
              id: conversationId,
              orgId: f.org.id,
              userId: `user_${f.id}`,
              workspaceId: f.workspaceId,
            }),
          )
          f.git("checkout", "-b", branch)
          const { writeFileSync } = await import("node:fs")
          const { join } = await import("node:path")
          writeFileSync(join(f.directory, "notes.md"), "# Published session\n")
          f.git("add", "notes.md")
          f.git("commit", "-m", "Published session")
          f.git("push", f.remote, `HEAD:refs/heads/${branch}`)
          expect(
            (
              await raw.process.exec(
                `git clone --depth 1 --branch ${shellSingleQuote(branch)} ${shellSingleQuote(`file://${f.remote}`)} .`,
              )
            ).exitCode,
          ).toBe(0)
          expect(
            (await raw.process.exec(`git cat-file -e ${f.sha}`)).exitCode,
          ).not.toBe(0)
          let revision = f.revision
          // ctx| pushed the published session itself.
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(conversations)
              .set({
                lastBranch: branch,
                lastPushedSha: f.git("rev-parse", "HEAD"),
              })
              .where(eq(conversations.id, conversationId)),
          )
          if (mode === "rebased") {
            f.git("checkout", "main")
            writeFileSync(join(f.directory, "human.md"), "# Default advanced\n")
            f.git("add", "human.md")
            f.git("commit", "-m", "Advance default")
            f.git("push", f.remote, "HEAD:refs/heads/main")
            revision = { ...f.revision, sha: f.git("rev-parse", "HEAD") }
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaces)
                .set({ desiredSha: revision.sha })
                .where(eq(workspaces.id, f.workspaceId)),
            )
            expect(
              (await raw.process.exec("git fetch --unshallow origin main"))
                .exitCode,
            ).toBe(0)
            expect(
              (
                await raw.process.exec(
                  "git -c user.name=Fixture -c user.email=fixture@example.test rebase FETCH_HEAD",
                )
              ).exitCode,
            ).toBe(0)
          }
          if (mode === "edited")
            await raw.fs.write("notes.md", "# Restored edit\n")
          await recordSandbox(f, conversationId, raw.id, revision)
          const result = await withOrgIdContext(f.org, () =>
            withUserIdContext(`user_${f.id}`, () =>
              pushConversationSession({
                handle: adaptTanstackHandle(raw),
                conversationId,
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                env: parseEnv(process.env),
                commit: { subject: "Publish restored session" },
              }),
            ),
          )
          expect(result).toEqual(
            mode === "unchanged"
              ? { status: "unchanged" }
              : { status: "pushed", branch, sha: expect.any(String) },
          )
          expect(
            f.git("--git-dir", f.remote, "show", `${branch}:notes.md`),
          ).toBe(mode === "edited" ? "# Restored edit" : "# Published session")
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
            revision.sha,
          )
        } finally {
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
