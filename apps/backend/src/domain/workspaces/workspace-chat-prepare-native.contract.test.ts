import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
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
