import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaceSandboxInstances } from "../../db/schema/workspaces.js"
import { captureGitPack } from "../../services/git/pack.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import {
  pushConversationSession,
  shellSingleQuote,
} from "./conversation-publish.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import { pushWorkspaceCommit } from "./write-broker.js"

/*
 * The Workspace root folder (CTX-709) at the two push brokers, with real git:
 * a commit that changes a file outside the root folder never reaches the
 * remote. The Workspace has the root folder docs/ctx.
 */

const ROOT = "docs/ctx"
const files = [
  { path: `${ROOT}/notes.md`, body: "# Notes\n" },
  { path: "src/app.ts", body: "export {}\n" },
]

it(
  "the write broker refuses a commit that changes a file outside the root folder",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        rootPath: ROOT,
        files,
      },
      async (f) => {
        await f.handle.cancel()
        f.git("reset", "--hard", f.sha)
        writeFileSync(join(f.directory, "src/app.ts"), "export const x = 1\n")
        writeFileSync(join(f.directory, `${ROOT}/notes.md`), "# Changed\n")
        f.git("add", "-A")
        f.git("commit", "-m", "Change a file outside the root folder")
        const committed = await captureGitPack(
          f.directory,
          f.git("rev-parse", "HEAD"),
          null,
        )
        expect(f.revision.rootPath).toBe(ROOT)
        await expect(
          withOrgIdContext(f.org, () =>
            pushWorkspaceCommit(
              { orgId: f.org.id, workspaceId: f.workspaceId },
              { ...f.revision, access: "write-default" },
              committed,
              parseEnv(process.env),
            ),
          ),
        ).rejects.toThrow(/outside the Workspace root folder/)
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      },
    )
  },
)

type Sandbox = Awaited<
  ReturnType<ReturnType<typeof localProcessSandbox>["create"]>
>

/**
 * Publishes a conversation session whose sandbox `edit` changed, and expects
 * the refusal `outside_root` with no change on the remote.
 */
async function expectSessionRefused(edit: (raw: Sandbox) => Promise<void>) {
  await withNativeHydrationFixture(
    {
      github: true,
      githubWriteView: "writable",
      writeStatus: "writable",
      rootPath: ROOT,
      files,
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
        await edit(raw)
        // Substitute the third-party GitHub transport.
        f.git(
          "config",
          "--file",
          process.env.GIT_CONFIG_GLOBAL ?? "missing",
          "--add",
          `url.${f.remote}.insteadOf`,
          "https://x-access-token:fixture-only-github-write-token@github.com/fixture/hydration-contract.git",
        )
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaceSandboxInstances).values({
            id: `sandbox-${conversationId}`,
            kind: "chat",
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            conversationId,
            provider: "local-process",
            providerSandboxId: raw.id,
            image: "local-process",
            revision: { ...f.revision, access: "read" },
            state: "live",
            lastHeartbeatAt: new Date(),
          }),
        )
        const result = await withOrgIdContext(f.org, () =>
          withUserIdContext(`user_${f.id}`, () =>
            pushConversationSession({
              handle: adaptTanstackHandle(raw),
              conversationId,
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              env: parseEnv(process.env),
              commit: { subject: "Publish the session" },
            }),
          ),
        )
        expect(result).toMatchObject({
          status: "skipped",
          reason: "outside_root",
        })
        // The remote has only the fixture commit: no session branch.
        expect(
          f.git("--git-dir", f.remote, "rev-list", "--all", "--count"),
        ).toBe("1")
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
      } finally {
        await raw.destroy()
        await withOrgDbContext(f.org.id, (db) =>
          db.delete(conversations).where(eq(conversations.id, conversationId)),
        )
      }
    },
  )
}

it(
  "conversation publishing refuses a session that changes a file outside the root folder",
  { timeout: 30_000 },
  () =>
    expectSessionRefused(async (raw) => {
      await raw.fs.write("src/app.ts", "export const x = 1\n")
    }),
)

it(
  "conversation publishing refuses a session whose history holds a file outside the root folder",
  { timeout: 30_000 },
  () =>
    expectSessionRefused(async (raw) => {
      // A later commit removes the file, so the net change is only below the
      // root folder, but the history still holds the file.
      const commit =
        "git -c user.name=Agent -c user.email=agent@example.com commit -q"
      await raw.fs.write("src/leak.ts", "export const secret = 1\n")
      await raw.process.exec(`git add -A && ${commit} -m leak`)
      await raw.process.exec(`git rm -q src/leak.ts && ${commit} -m remove`)
      await raw.fs.write(`${ROOT}/notes.md`, "# Changed\n")
    }),
)
