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
  workspaceKnowledgeUnits,
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import {
  deleteConversationThreadRecords,
  listConversationSyncs,
} from "../../models/conversation-turn-changes.js"
import type { NativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { conversationSessionBranch } from "./chat-lifecycle.js"
import {
  pushConversationSession,
  recordConversationPush,
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
  "oversized_pack",
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
          const handle = adaptTanstackHandle(raw)
          const request = {
            handle:
              scenario === "oversized_pack"
                ? {
                    ...handle,
                    // The sandbox reports a pack size above the limit.
                    exec: (
                      command: string,
                      options?: Parameters<typeof handle.exec>[1],
                    ) =>
                      command.startsWith("wc -c <")
                        ? Promise.resolve({
                            exitCode: 0,
                            stdout: `${100 * 1024 * 1024 + 1}\n`,
                            stderr: "",
                          })
                        : handle.exec(command, options),
                  }
                : handle,
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
              files: 1,
              treeUrl: expect.any(String),
              dirty: false,
            })
            expect(
              f.git("--git-dir", f.remote, "show", `${branch}:notes.md`),
            ).toBe("# Conversation edit")
          } else {
            expect(result).toEqual(
              scenario === "session_advanced" || scenario === "oversized_pack"
                ? { status: "failed", reason: "push_failed", dirty: false }
                : scenario === "default_changed"
                  ? // The session branch became the default: never pushed to.
                    {
                      status: "skipped",
                      reason: "default_branch",
                      dirty: false,
                    }
                  : {
                      status: "skipped",
                      reason: "stale_binding",
                      dirty: false,
                    },
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
          ).toEqual(
            // An oversized pack is refused before the write token exists.
            scenario === "oversized_pack"
              ? []
              : [
                  {
                    repositories: ["hydration-contract"],
                    permissions: { contents: "write", metadata: "read" },
                  },
                ],
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
              ? { status: "unchanged", dirty: false }
              : {
                  status: "pushed",
                  branch,
                  sha: expect.any(String),
                  files: 1,
                  treeUrl: expect.any(String),
                  dirty: false,
                },
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

it(
  "counts the files a push changed, a rename as one file",
  {
    timeout: 30_000,
  },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
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
          f.git(
            "config",
            "--file",
            process.env.GIT_CONFIG_GLOBAL ?? "missing",
            "--add",
            `url.${f.remote}.insteadOf`,
            "https://github.com/fixture/hydration-contract.git",
          )
          await recordSandbox(f, conversationId, raw.id, f.revision)
          const push = () =>
            withOrgIdContext(f.org, () =>
              withUserIdContext(`user_${f.id}`, () =>
                pushConversationSession({
                  handle: adaptTanstackHandle(raw),
                  conversationId,
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  env: parseEnv(process.env),
                  commit: { subject: "Sync conversation edit" },
                }),
              ),
            )
          await raw.fs.write("notes.md", "# Conversation edit\n")
          await raw.fs.write(
            "docs/plan.md",
            "# Plan\n\nA long enough body so that Git finds the rename.\n",
          )

          const first = await push()
          await raw.process.exec("git mv docs/plan.md docs/plan-v2.md")
          const renamed = await push()

          expect(first).toMatchObject({ status: "pushed", files: 2 })
          expect(renamed).toMatchObject({ status: "pushed", files: 1 })
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

const HUMAN_UNIT = "---\nkind: Service\nname: Checkout\n---\n\n# Checkout\n"
const GENERATED_UNIT =
  "---\nkind: Service\nname: Billing\ngenerated_by: ctxpipe-extract\nsources:\n  - https://github.com/fixture/billing\n---\n\n# Billing\n"

// CTX-722: a chat agent can change the Workspace sources config, because a
// publish only reaches the session branch, and the change reaches the default
// branch only through a pull request that a person merges. The agent cannot
// give a person's file to ingestion.
it.each([
  {
    name: "edits the sources config",
    edit: "printf 'sources:\\n  - other\\n' > .ctxpipe/sources.yaml",
    reason: null,
  },
  {
    name: "deletes the sources config",
    edit: "git rm -q .ctxpipe/sources.yaml",
    reason: null,
  },
  {
    name: "renames the sources config",
    edit: "git mv .ctxpipe/sources.yaml sources.yaml",
    reason: null,
  },
  {
    name: "adds a file under .ctxpipe",
    edit: "printf '# Skill\\n' > .ctxpipe/skill.md",
    reason: null,
  },
  {
    name: "adds generated_by to a human file",
    edit: `printf '%s' ${shellSingleQuote(HUMAN_UNIT.replace("name: Checkout\n", "name: Checkout\ngenerated_by: ctxpipe-extract\n"))} > knowledge/services/checkout.md`,
    reason: "host_only_field",
  },
  {
    name: "copies a generated file to a new path",
    edit: "cp knowledge/services/billing.md knowledge/services/billing-copy.md",
    reason: "host_only_field",
  },
  {
    name: "removes generated_by and sources from a generated file",
    edit: `printf '%s' ${shellSingleQuote("---\nkind: Service\nname: Billing\n---\n\n# Billing\n")} > knowledge/services/billing.md`,
    reason: null,
  },
  {
    name: "renames a generated file",
    edit: "git mv knowledge/services/billing.md knowledge/services/billing-v2.md",
    reason: null,
  },
  {
    name: "renames a pushed text file with ownership fields to Markdown",
    first: `printf '%s' ${shellSingleQuote(GENERATED_UNIT)} > knowledge/services/y.txt`,
    edit: "git mv knowledge/services/y.txt knowledge/services/y.md",
    reason: "host_only_field",
  },
  {
    name: "edits the sources config when the session branch is the default",
    edit: "printf 'sources:\\n  - other\\n' > .ctxpipe/sources.yaml",
    sessionIsDefault: true,
    reason: "default_branch",
  },
  {
    name: "adds and then removes generated_by in two commits",
    edit: `printf '%s' ${shellSingleQuote(HUMAN_UNIT.replace("name: Checkout\n", "name: Checkout\ngenerated_by: ctxpipe-extract\n"))} > knowledge/services/checkout.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qam add && printf '%s' ${shellSingleQuote(HUMAN_UNIT)} > knowledge/services/checkout.md && git -c user.name=Fixture -c user.email=fixture@example.test commit -qam remove`,
    reason: "host_only_field",
  },
  {
    name: "changes the Workspace format file",
    format: 2,
    edit: "printf 'format: 3\\n' > .ctxpipe/workspace.yaml",
    reason: "format_file",
  },
  {
    name: "adds the Workspace format file",
    edit: "printf 'format: 2\\n' > .ctxpipe/workspace.yaml",
    reason: "format_file",
  },
  {
    name: "adds a source file below format 2",
    format: 1,
    edit: "mkdir -p sources/linear && printf -- '---\\nprovider: linear\\n---\\n' > sources/linear/eng.md",
    reason: "upgrade_needed",
  },
  {
    name: "adds a source file with no format file",
    edit: "mkdir -p sources/linear && printf -- '---\\nprovider: linear\\n---\\n' > sources/linear/eng.md",
    reason: "upgrade_needed",
  },
  {
    name: "writes a path of main-era knowledge that is not in git",
    legacyPath: "knowledge/services/tools-cli.md",
    edit: "printf '# Tools\\n' > knowledge/services/tools-cli.md",
    reason: "legacy_knowledge",
  },
  {
    name: "adds a source file at format 2",
    format: 2,
    edit: "mkdir -p sources/linear && printf -- '---\\nprovider: linear\\n---\\n' > sources/linear/eng.md",
    reason: null,
  },
] as Array<{
  name: string
  first?: string
  sessionIsDefault?: boolean
  /** The Workspace format file at the base, when there is one. */
  format?: number
  /** A main-era knowledge unit that hydrate serves from Postgres. */
  legacyPath?: string
  edit: string
  reason: string | null
}>)(
  "conversation publish when the agent $name",
  { timeout: 30_000 },
  async ({ first, edit, sessionIsDefault, format, legacyPath, reason }) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [
          { path: ".ctxpipe/sources.yaml", body: "sources: []\n" },
          { path: "knowledge/services/checkout.md", body: HUMAN_UNIT },
          { path: "knowledge/services/billing.md", body: GENERATED_UNIT },
          ...(format === undefined
            ? []
            : [
                {
                  path: ".ctxpipe/workspace.yaml",
                  body: `format: ${format}\n`,
                },
              ]),
        ],
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
          f.git(
            "config",
            "--file",
            process.env.GIT_CONFIG_GLOBAL ?? "missing",
            "--add",
            `url.${f.remote}.insteadOf`,
            "https://github.com/fixture/hydration-contract.git",
          )
          await recordSandbox(f, conversationId, raw.id, f.revision)
          if (legacyPath)
            await withOrgDbContext(f.org.id, (db) =>
              db.insert(workspaceKnowledgeUnits).values({
                servingId: `unit_legacy_${f.id}`,
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                path: legacyPath,
                source: "legacy",
                body: "The release tools.",
                projectionSha: f.sha,
              }),
            )
          const push = () =>
            withOrgIdContext(f.org, () =>
              withUserIdContext(`user_${f.id}`, () =>
                pushConversationSession({
                  handle: adaptTanstackHandle(raw),
                  conversationId,
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  env: parseEnv(process.env),
                  commit: { subject: "Conversation edit" },
                }),
              ),
            )
          const branch = conversationSessionBranch(conversationId)
          if (first) {
            expect((await raw.process.exec(first)).exitCode).toBe(0)
            expect(await push()).toMatchObject({ status: "pushed", branch })
          }
          const commits = f.git(
            "--git-dir",
            f.remote,
            "rev-list",
            "--all",
            "--count",
          )
          expect((await raw.process.exec(edit)).exitCode).toBe(0)
          if (sessionIsDefault) {
            f.git(
              "--git-dir",
              f.remote,
              "update-ref",
              `refs/heads/${branch}`,
              f.sha,
            )
            f.git(
              "--git-dir",
              f.remote,
              "symbolic-ref",
              "HEAD",
              `refs/heads/${branch}`,
            )
          }

          const result = await push()

          if (reason) {
            expect(result).toEqual({ status: "skipped", reason, dirty: false })
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
            ).toBe(commits)
          } else {
            expect(result).toMatchObject({ status: "pushed", branch })
          }
          expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
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

it("writes no push entry for a conversation that was deleted meanwhile", async () => {
  await withNativeHydrationFixture({}, async (f) => {
    const live = `conv_${f.id}_live`
    const deleted = `conv_${f.id}_deleted`
    await withOrgDbContext(f.org.id, (db) =>
      db.insert(conversations).values({
        id: live,
        orgId: f.org.id,
        userId: `user_${f.id}`,
        workspaceId: f.workspaceId,
      }),
    )
    const record = (conversationId: string) =>
      withOrgIdContext(f.org, () =>
        recordConversationPush({
          orgId: f.org.id,
          conversationId,
          trigger: "sweep",
          pushed: {
            status: "pushed",
            branch: "ctxpipe/chat/conv_1/1",
            sha: "d".repeat(40),
            files: 1,
            treeUrl:
              "https://github.com/fixture/hydration-contract/tree/ctxpipe/chat/conv_1/1",
          },
        }),
      )
    try {
      await record(live)
      // The sweep pushed after the user deleted the conversation.
      await record(deleted)

      const count = async (conversationId: string) =>
        (await listConversationSyncs({ orgId: f.org.id, conversationId }))
          .length
      expect([await count(live), await count(deleted)]).toEqual([1, 0])
    } finally {
      await withOrgDbContext(f.org.id, async (db) => {
        for (const id of [live, deleted])
          await deleteConversationThreadRecords(db, id)
        await db.delete(conversations).where(eq(conversations.id, live))
      })
    }
  })
})
