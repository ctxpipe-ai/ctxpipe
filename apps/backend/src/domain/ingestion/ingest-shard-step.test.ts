import { describe, expect, it } from "vitest"

import { RunVaultLostError } from "../workspaces/agent-vault.js"
import type { RootExec } from "./ingest-root.js"
import { withShardStep } from "./ingest-shard-step.js"

const BUNDLE = "ingest-0000000000000000"

describe("the plain git source fetch of a shard step (CTX-815)", () => {
  /**
   * The bundle name in the sandbox's prepared marker, as
   * `ingestShardPreparedBundle` reads it; null: no marker.
   */
  let marker: string | null = null
  const root: RootExec = async (script) =>
    script.startsWith("cat ") && marker === null
      ? { exitCode: 1, stdout: "", stderr: "No such file" }
      : { exitCode: 0, stdout: marker ?? "", stderr: "" }

  /** One step as `withShard` runs it; `events` gets each sandbox action. */
  function stepOf(input: {
    existing: boolean
    events: string[]
    prepare?: () => Promise<void>
  }) {
    return withShardStep({
      existingRoot: input.existing ? root : null,
      bundle: BUNDLE,
      plainGitSource: true,
      refresh: async (fetchSource) => {
        input.events.push(`rules:${fetchSource ? "fetch" : "no-fetch"}`)
      },
      destroy: async () => undefined,
      attach: async () => ({ handle: { id: "sbx-ingest" }, root }),
      prepare: async () => {
        input.events.push("prepare")
        await input.prepare?.()
        marker = BUNDLE
      },
      refreshBundle: async () => {
        input.events.push("refresh-bundle")
        marker = BUNDLE
      },
      run: async () => undefined,
      stopAgents: async () => undefined,
      logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
    })
  }

  it("sets the vault rules with the source fetch only for the prepare, also when it fails", async () => {
    const events: string[] = []
    // An existing, prepared sandbox: this step's rules, with no source fetch.
    marker = BUNDLE
    await stepOf({ existing: true, events })
    expect(events).toEqual(["rules:no-fetch"])
    // An existing, unprepared sandbox: the source fetch, then no fetch.
    marker = null
    await stepOf({ existing: true, events })
    expect(events.slice(1)).toEqual([
      "rules:fetch",
      "prepare",
      "rules:no-fetch",
    ])
    // A new sandbox got the source fetch rules at create; a failed prepare
    // removes them.
    marker = null
    const failed: string[] = []
    await expect(
      stepOf({
        existing: false,
        events: failed,
        prepare: () => Promise.reject(new Error("The clone failed")),
      }),
    ).rejects.toThrow("The clone failed")
    expect(failed).toEqual(["prepare", "rules:no-fetch"])
  })

  it("puts the new bundle in a prepared sandbox after a deploy, with no source fetch (CTX-1503)", async () => {
    // A sandbox of the old bundle, and one whose bundle refresh stopped
    // part of the way (an empty marker).
    for (const old of ["ingest-1111111111111111", ""]) {
      const events: string[] = []
      marker = old
      await stepOf({ existing: true, events })
      expect(events).toEqual(["rules:no-fetch", "refresh-bundle"])
    }
  })
})

describe("a shard step whose vault Agent Vault lost", () => {
  it("destroys the sandbox and fails before it attaches, so the next attempt makes a new one", async () => {
    const calls: string[] = []
    const root: RootExec = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    await expect(
      withShardStep({
        existingRoot: root,
        bundle: BUNDLE,
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
        refreshBundle: async () => undefined,
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
        bundle: BUNDLE,
        plainGitSource: false,
        refresh: () =>
          Promise.reject(new Error("Agent Vault is not reachable")),
        destroy: async () => {
          destroyed = true
        },
        attach: async () => ({ handle: { id: "sbx-kept" }, root }),
        prepare: async () => undefined,
        refreshBundle: async () => undefined,
        run: async () => undefined,
        stopAgents: async () => undefined,
        logContext: { orgId: "org_shard_step", runId: "run_shard_step" },
      }),
    ).rejects.toThrow("not reachable")
    expect(destroyed).toBe(false)
  })
})
