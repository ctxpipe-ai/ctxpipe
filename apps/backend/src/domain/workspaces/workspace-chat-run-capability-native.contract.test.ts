import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import { workspaceRevisionSchema } from "./revision.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  mintWorkspaceChatRunCapability,
  verifyWorkspaceChatRunCapability,
} from "./workspace-chat-run-capability.js"

it(
  "authorizes only the live transcript owner and current workspace binding",
  { timeout: 60_000 },
  async () => {
    await withNativeChatFixture(async (fixture) => {
      const authSecret = "workspace-chat-run-capability-test-secret"
      const revision = workspaceRevisionSchema.parse({
        workspaceId: fixture.workspaceId,
        generation: 1,
        remote: { url: fixture.directory, connectionId: null },
        sha: fixture.sha,
        defaultBranch: "main",
        access: "read",
      })
      const lockKey = `chat-thread:${fixture.conversationId}`
      const acquisitions: Array<{ key: string; owner: string }> = []
      const locks = postgresSandboxLocks(
        fixture.orgId,
        undefined,
        undefined,
        (receipt) => {
          acquisitions.push(receipt)
        },
      )
      let firstOwner: string | undefined

      const firstToken = await locks.withLock(lockKey, async () => {
        const acquisition = acquisitions[acquisitions.length - 1]
        if (!acquisition || acquisition.key !== lockKey)
          throw new Error("Lock acquisition receipt was not captured")
        firstOwner = acquisition.owner
        const token = await mintWorkspaceChatRunCapability({
          authSecret,
          orgId: fixture.orgId,
          conversationId: fixture.conversationId,
          expectedOwner: acquisition.owner,
          revision,
          purpose: "workspace-chat-git",
        })
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token,
            purpose: "workspace-chat-git",
          }),
        ).toMatchObject({
          orgId: fixture.orgId,
          conversationId: fixture.conversationId,
          revision,
        })
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token,
            purpose: "workspace-chat-model",
          }),
        ).toBeUndefined()
        const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token: tampered,
            purpose: "workspace-chat-git",
          }),
        ).toBeUndefined()

        await withOrgDbContext(fixture.orgId, (db) =>
          db
            .update(workspaces)
            .set({ desiredSha: "a".repeat(40) })
            .where(eq(workspaces.id, fixture.workspaceId)),
        )
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token,
            purpose: "workspace-chat-git",
          }),
        ).toBeDefined()
        return token
      })
      if (!firstOwner) throw new Error("Initial lock owner was not captured")
      const firstLockOwner = firstOwner

      expect(
        await verifyWorkspaceChatRunCapability({
          authSecret,
          token: firstToken,
          purpose: "workspace-chat-git",
        }),
      ).toBeUndefined()
      await expect(
        mintWorkspaceChatRunCapability({
          authSecret,
          orgId: "org_other",
          conversationId: fixture.conversationId,
          expectedOwner: firstLockOwner,
          revision,
          purpose: "workspace-chat-git",
        }),
      ).rejects.toThrow()

      await locks.withLock(lockKey, async () => {
        const acquisition = acquisitions[acquisitions.length - 1]
        if (!acquisition || acquisition.key !== lockKey)
          throw new Error(
            "Replacement lock acquisition receipt was not captured",
          )
        const replacementOwner = acquisition.owner
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token: firstToken,
            purpose: "workspace-chat-git",
          }),
        ).toBeUndefined()
        await expect(
          mintWorkspaceChatRunCapability({
            authSecret,
            orgId: fixture.orgId,
            conversationId: fixture.conversationId,
            expectedOwner: firstLockOwner,
            revision,
            purpose: "workspace-chat-model",
          }),
        ).rejects.toThrow()
        const replacement = await mintWorkspaceChatRunCapability({
          authSecret,
          orgId: fixture.orgId,
          conversationId: fixture.conversationId,
          expectedOwner: replacementOwner,
          revision,
          purpose: "workspace-chat-model",
        })
        expect(replacement).not.toBe(firstToken)
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token: replacement,
            purpose: "workspace-chat-model",
          }),
        ).toBeDefined()
        await withOrgDbContext(fixture.orgId, (db) =>
          db
            .update(workspaces)
            .set({ desiredGeneration: 2 })
            .where(eq(workspaces.id, fixture.workspaceId)),
        )
        expect(
          await verifyWorkspaceChatRunCapability({
            authSecret,
            token: replacement,
            purpose: "workspace-chat-model",
          }),
        ).toBeUndefined()
      })
    })
  },
)
