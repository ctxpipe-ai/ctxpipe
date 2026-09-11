import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defineSandbox,
  InMemorySandboxInstanceStore,
  type SandboxEnsureContext,
  type SandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { expect, it } from "vitest"
import { faultDockerCommitReply } from "../../test/native-docker-ack-loss.js"

const NODE_IMAGE =
  "node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d"

function cleanupErrors(primary: unknown, cleanup: unknown[]): never {
  if (cleanup.length > 0)
    throw new AggregateError(
      [primary, ...cleanup],
      "Native snapshot recovery proof and cleanup failed",
    )
  throw primary
}

it.each(["reject-before-forward", "reset-after-commit"] as const)(
  "recovers a native base snapshot after Docker commit fault: %s",
  { timeout: 180_000 },
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-snapshot-recovery-"))
    const fault = await faultDockerCommitReply(
      join(directory, "docker.sock"),
      mode,
    )
    const provider = dockerSandbox({
      image: NODE_IMAGE,
      workdir: "/workspace",
      dockerodeOptions: { socketPath: fault.socketPath, timeout: 120_000 },
      egress: {
        proxyImage: NODE_IMAGE,
        allowConnect: [],
        allowHttp: [],
      },
    })
    const store = new InMemorySandboxInstanceStore()
    const definition = defineSandbox({
      id: `snapshot-recovery-${mode}`,
      provider,
      lifecycle: {
        reuse: "thread",
        snapshot: "after-setup",
        baseSnapshot: true,
      },
    })
    const workspace = {
      identity: `snapshot-recovery-workspace-${mode}-${Date.now()}`,
      source: { type: "none" as const },
    }
    const context: SandboxEnsureContext = {
      threadId: `snapshot-recovery-thread-${mode}`,
      runId: `snapshot-recovery-run-${mode}`,
      workspace,
      store,
    }
    const baseKey = `base:${definition.key({ ...context, threadId: "" })}`
    const threadKey = definition.key(context)
    let base: SandboxInstanceRecord | null = null
    let thread: SandboxInstanceRecord | null = null
    let primary: unknown
    const ownedContainerIds = new Set<string>()
    const ownedSnapshotIds = new Set<string>()

    try {
      if (mode === "reject-before-forward") {
        await expect(definition.ensure(context)).rejects.toThrow(
          "injected snapshot commit failure",
        )
        const rejected = await fault.fault
        ownedContainerIds.add(rejected.containerId)
        base = await store.get(baseKey)
        expect(base).toMatchObject({
          key: baseKey,
          latestSnapshotId: undefined,
        })
        const originalContainerId = base?.providerSandboxId
        expect(originalContainerId).toBeTruthy()
        if (originalContainerId) ownedContainerIds.add(originalContainerId)

        const recovered = await definition.ensure({
          ...context,
          runId: `${context.runId}-retry`,
        })
        base = await store.get(baseKey)
        thread = await store.get(threadKey)
        expect(base?.providerSandboxId).toBe(originalContainerId)
        expect(base?.latestSnapshotId).toBeTruthy()
        expect(recovered.id).toBe(thread?.providerSandboxId)
        ownedContainerIds.add(recovered.id)
        expect(fault.commitRequests()).toBe(2)
      } else {
        const recovered = await definition.ensure(context)
        const committed = await fault.fault
        ownedContainerIds.add(committed.containerId)
        ownedContainerIds.add(recovered.id)
        base = await store.get(baseKey)
        thread = await store.get(threadKey)
        expect(committed.containerId).toBe(base?.providerSandboxId)
        expect(base?.latestSnapshotId).toBeTruthy()
        expect(recovered.id).toBe(thread?.providerSandboxId)
        expect(fault.commitRequests()).toBe(1)
      }
    } catch (error) {
      primary = error
    }

    const cleanup: unknown[] = []
    try {
      thread = (await store.get(threadKey)) ?? thread
      if (thread) {
        ownedContainerIds.add(thread.providerSandboxId)
        if (thread.latestSnapshotId)
          ownedSnapshotIds.add(thread.latestSnapshotId)
      }
      base = (await store.get(baseKey)) ?? base
      if (base) {
        ownedContainerIds.add(base.providerSandboxId)
        if (base.latestSnapshotId) ownedSnapshotIds.add(base.latestSnapshotId)
      }
    } catch (error) {
      cleanup.push(error)
    }
    for (const id of ownedContainerIds) {
      try {
        await provider.destroy({ id })
      } catch (error) {
        cleanup.push(error)
      }
    }
    for (const snapshotId of ownedSnapshotIds) {
      try {
        await provider.deleteSnapshot?.({ snapshotId })
      } catch (error) {
        cleanup.push(error)
      }
    }
    try {
      await fault.close()
    } catch (error) {
      cleanup.push(error)
    }
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      cleanup.push(error)
    }
    if (primary !== undefined) cleanupErrors(primary, cleanup)
    if (cleanup.length > 0)
      throw new AggregateError(
        cleanup,
        "Native snapshot recovery cleanup failed",
      )
  },
)
