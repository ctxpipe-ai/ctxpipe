import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { warmTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
import { destroySandboxesForConversation } from "./workspace-sandbox-cleanup.js"

it(
  "prepare preserves the native worktree while refreshing its credentials",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      const previous = process.env.SANDBOX_PROVIDER
      process.env.SANDBOX_PROVIDER = "unsandboxed"
      const conversationId = `conv_${f.id}`
      const input = {
        conversationId,
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        desiredUrl: f.remote,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      }
      try {
        await withOrgIdContext(f.org, () =>
          withTestLogger(async () => {
            const firstResult = await warmTanstackWorkspaceChat({
              ...input,
            })
            if (!firstResult.ok) throw new Error(firstResult.error)
            const first = firstResult.handle
            await first.fs.write("unsaved.txt", "preserve unsaved work")
            const secondResult = await warmTanstackWorkspaceChat({
              ...input,
              cloneToken: "fixture-token-b",
            })
            if (!secondResult.ok) throw new Error(secondResult.error)
            const second = secondResult.handle
            expect(second?.id).toBe(first.id)
            expect(await second?.fs.read("unsaved.txt")).toBe(
              "preserve unsaved work",
            )
            expect(
              (
                await second?.process.exec("printenv CTXPIPE_CLONE_TOKEN")
              )?.stdout.trim(),
            ).toBe("fixture-token-b")
            const changed = await warmTanstackWorkspaceChat({
              ...input,
              desiredGeneration: 2,
              cloneToken: "fixture-token-b",
            })
            if (!changed.ok) throw new Error(changed.error)
            expect(changed.handle.id).not.toBe(first.id)
            expect(await first.fs.read("unsaved.txt")).toBe(
              "preserve unsaved work",
            )
          }),
        )
      } finally {
        await withOrgIdContext(f.org, () =>
          destroySandboxesForConversation(conversationId),
        )
        if (previous === undefined) delete process.env.SANDBOX_PROVIDER
        else process.env.SANDBOX_PROVIDER = previous
      }
    })
  },
)

it(
  "prepares the captured SHA when the remote default branch has advanced",
  { timeout: 30_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await writeFile(
        join(f.directory, "README.md"),
        "# Newer unselected revision\n",
      )
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-am",
          "Advance default branch",
        ],
        { cwd: f.directory },
      )
      const prepared = await warmTanstackWorkspaceChat({
        conversationId: f.conversationId,
        orgId: f.orgId,
        orgSlug: f.orgSlug,
        workspaceId: f.workspaceId,
        desiredUrl: f.directory,
        desiredSha: f.sha,
        defaultBranch: "main",
        writeStatus: "read_only",
        prompt: "prepare",
      })
      if (!prepared.ok) throw new Error(prepared.error)
      expect(
        (
          await prepared.handle.process.exec("git rev-parse HEAD")
        ).stdout.trim(),
      ).toBe(f.sha)
      expect(await prepared.handle.fs.read("README.md")).toBe(
        "# Native chat workspace\n",
      )
    })
  },
)
