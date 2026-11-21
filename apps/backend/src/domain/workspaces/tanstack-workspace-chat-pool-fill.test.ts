import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineWorkspace, gitSource } from "@tanstack/ai-sandbox"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { afterAll, beforeAll, expect, it } from "vitest"

import { conversationSandboxDefinition } from "./tanstack-workspace-chat.js"

let dir: string
let sha: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tanstack-workspace-chat-pool-fill-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  writeFileSync(join(dir, "README.md"), "hi\n")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  sha = git("rev-parse", "HEAD")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// The prepare of a new conversation calls `ensure` directly; a turn calls it
// through `withSandbox`. Each one that gives a sandbox starts a pool fill
// (ADR-061 decision 18), so the next new conversation finds a warm session.
it("runs onEnsured after the prepare creates the sandbox and when a turn resumes it, not for a Files read", async () => {
  let ensured = 0
  const definition = conversationSandboxDefinition({
    provider: localProcessSandbox(),
    workspace: defineWorkspace({
      source: gitSource({ url: dir, ref: "main" }),
    }),
    image: "local",
    revision: {
      workspaceId: "ws_definition",
      generation: 1,
      remote: { url: dir, connectionId: null },
      defaultBranch: "main",
      sha,
      access: "read",
    },
    conversationId: "conv_definition",
    onEnsured: () => {
      ensured += 1
    },
  })
  const ctx = {
    threadId: "conv_definition",
    runId: "prepare-conv_definition",
    tenant: { userId: undefined, orgId: "org_definition" },
    adapterName: "opencode",
  }
  const handle = await definition.ensure(ctx)
  try {
    expect(ensured).toBe(1)
    await definition.ensure({ ...ctx, runId: "run_turn" })
    expect(ensured).toBe(2)
    // A Files read attaches only: it fills nothing.
    expect(
      await definition.ensureExisting({ ...ctx, runId: "files" }),
    ).not.toBeNull()
    expect(ensured).toBe(2)
  } finally {
    await handle.destroy()
  }
})
