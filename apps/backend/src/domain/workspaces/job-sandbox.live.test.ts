import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { describe, expect, it } from "vitest"
import { adaptTanstackHandle } from "./job-sandbox.js"
import { runJobWorktree } from "./job-worktree.js"

describe("in-process job sandbox", () => {
  it("adds a worktree, writes files, and reads them out for the runner", async () => {
    const provider = localProcessSandbox()
    const raw = await provider.create({ id: "job-live" })
    try {
      await raw.process.exec("git init")
      await raw.process.exec("git config user.email test@ctxpipe.local")
      await raw.process.exec("git config user.name ctxpipe")
      await raw.process.exec("git commit --allow-empty -m init")
      const handle = adaptTanstackHandle(raw)
      const result = await runJobWorktree({
        worktree: "job-live-wt",
        files: [{ path: "knowledge/a.md", content: "hello from worktree" }],
        exec: handle.exec,
        fs: handle.fs,
      })
      expect(result.files).toContainEqual({
        path: "knowledge/a.md",
        content: "hello from worktree",
      })
    } finally {
      await raw.destroy()
    }
  })
})
