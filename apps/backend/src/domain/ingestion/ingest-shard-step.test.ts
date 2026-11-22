import { describe, expect, it } from "vitest"

import { RunVaultLostError } from "../workspaces/agent-vault.js"
import type { RootExec } from "./ingest-root.js"
import { withShardStep } from "./ingest-shard-step.js"

describe("the plain git source fetch of a shard step (CTX-815)", () => {
  /** The sandbox's prepared marker, as `ingestShardPrepared` reads it. */
  let prepared = false
  const root: RootExec = async (script) => ({
    exitCode: script.startsWith("test -f ") && !prepared ? 1 : 0,
    stdout: "",
    stderr: "",
  })

  /** One step as `withShard` runs it. */
  function stepOf(input: {
    existing: boolean
    refresh: (fetchSource: boolean) => Promise<void>
    prepare?: () => Promise<void>
  }) {
    return withShardStep({
      existingRoot: input.existing ? root : null,
      plainGitSource: true,
      refresh: input.refresh,
      destroy: async () => undefined,
      attach: async () => ({ handle: { id: "sbx-ingest" }, root }),
      prepare: async () => {
        await input.prepare?.()
        prepared = true
      },
      run: async () => undefined,
      stopAgents: async () => undefined,
      logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
    })
  }

  it("sets the vault rules with the source fetch only for the prepare, also when it fails", async () => {
    const refreshes: boolean[] = []
    const refresh = async (fetchSource: boolean) => {
      refreshes.push(fetchSource)
    }
    // An existing, prepared sandbox: this step's rules, with no source fetch.
    prepared = true
    await stepOf({ existing: true, refresh })
    expect(refreshes).toEqual([false])
    // An existing, unprepared sandbox: the source fetch, then no fetch.
    prepared = false
    await stepOf({ existing: true, refresh })
    expect(refreshes).toEqual([false, true, false])
    // A new sandbox got the source fetch rules at create; a failed prepare
    // removes them.
    prepared = false
    await expect(
      stepOf({
        existing: false,
        refresh,
        prepare: () => Promise.reject(new Error("The clone failed")),
      }),
    ).rejects.toThrow("The clone failed")
    expect(refreshes).toEqual([false, true, false, false])
  })
})

describe("a shard step whose vault Agent Vault lost", () => {
  it("destroys the sandbox and fails before it attaches, so the next attempt makes a new one", async () => {
    const calls: string[] = []
    const root: RootExec = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    await expect(
      withShardStep({
        existingRoot: root,
        plainGitSource: false,
        refresh: async () => {
          calls.push("refresh")
          throw new RunVaultLostError()
        },
        destroy: async () => {
          calls.push("destroy")
        },
        attach: async () => {
          calls.push("attach")
          return { handle: { id: "sbx-lost" }, root }
        },
        prepare: async () => undefined,
        run: async () => calls.push("run"),
        stopAgents: async () => undefined,
        logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
      }),
    ).rejects.toBeInstanceOf(RunVaultLostError)
    expect(calls).toEqual(["refresh", "destroy"])
  })

  it("keeps the sandbox when the refresh fails for another reason", async () => {
    let destroyed = false
    const root: RootExec = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    await expect(
      withShardStep({
        existingRoot: root,
        plainGitSource: false,
        refresh: () =>
          Promise.reject(new Error("Agent Vault is not reachable")),
        destroy: async () => {
          destroyed = true
        },
        attach: async () => ({ handle: { id: "sbx-kept" }, root }),
        prepare: async () => undefined,
        run: async () => undefined,
        stopAgents: async () => undefined,
        logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
      }),
    ).rejects.toThrow("not reachable")
    expect(destroyed).toBe(false)
  })
})
