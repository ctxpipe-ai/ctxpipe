import { describe, expect, it, vi } from "vitest"
import {
  jobWorktreeAddCommand,
  joinWorktreePath,
  parseGitStatusPorcelain,
  realpathInsideRoot,
  runJobWorktree,
  sandboxEnvHasWriteCredentials,
} from "./job-worktree.js"
import { applyJobWorktreeIfPresent } from "./write-job-agent.js"

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    fs: {
      write: async (path: string, data: string) => {
        files.set(path, data)
      },
      read: async (path: string) => {
        const content = files.get(path)
        if (content == null) throw new Error(`missing ${path}`)
        return content
      },
      remove: async (path: string) => {
        files.delete(path)
      },
      mkdir: async () => undefined,
    },
  }
}

describe("job worktree runner", () => {
  it("refuses write credentials in the sandbox env", () => {
    expect(sandboxEnvHasWriteCredentials({ PATH: "/bin" })).toBe(false)
    expect(sandboxEnvHasWriteCredentials({ GITHUB_TOKEN: "ghs_x" })).toBe(true)
    expect(sandboxEnvHasWriteCredentials({ GH_TOKEN: "x" })).toBe(true)
    expect(sandboxEnvHasWriteCredentials({ INSTALLATION_TOKEN: "x" })).toBe(
      true,
    )
  })

  it("refuses paths that escape the worktree, including resolved .. segments", () => {
    expect(joinWorktreePath("job-job_1", "knowledge/a.md")).toBe(
      "job-job_1/knowledge/a.md",
    )
    expect(joinWorktreePath("job-job_1", "../secret")).toBeNull()
    expect(joinWorktreePath("/work", "/work/../etc/passwd")).toBeNull()
  })

  it("rejects a realpath that leaves the worktree", async () => {
    await expect(
      realpathInsideRoot({
        root: "/work/job-1",
        candidate: "/work/job-1/knowledge/a.md",
        realpath: async () => "/etc/passwd",
      }),
    ).resolves.toBeNull()
    await expect(
      realpathInsideRoot({
        root: "/work/job-1",
        candidate: "/work/job-1/knowledge/a.md",
        realpath: async () => "/work/job-1/knowledge/a.md",
      }),
    ).resolves.toBe("/work/job-1/knowledge/a.md")
  })

  it("parses porcelain adds, edits, and deletes", () => {
    expect(
      parseGitStatusPorcelain(
        ["A  knowledge/a.md", " M knowledge/b.md", "D  knowledge/c.md"].join(
          "\n",
        ),
      ),
    ).toEqual({
      files: ["knowledge/a.md", "knowledge/b.md"],
      deletePaths: ["knowledge/c.md"],
    })
  })

  it("adds a worktree, writes files, stages, reads them out, and removes it", async () => {
    const commands: string[] = []
    const { fs, files } = memoryFs()
    const result = await runJobWorktree({
      worktree: "job-job_1",
      files: [{ path: "knowledge/a.md", content: "hello" }],
      deletePaths: ["knowledge/gone.md"],
      exec: async (command, options) => {
        if (options?.env && sandboxEnvHasWriteCredentials(options.env)) {
          throw new Error("token leaked into sandbox")
        }
        commands.push(command)
        if (command.includes("status --porcelain")) {
          return {
            stdout: "A  knowledge/a.md\nD  knowledge/gone.md\n",
            stderr: "",
            exitCode: 0,
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      fs,
    })
    expect(commands[0]).toBe("git worktree add -- job-job_1 HEAD")
    expect(jobWorktreeAddCommand("job-job_1")).toBe(
      "git worktree add -- job-job_1 HEAD",
    )
    expect(jobWorktreeAddCommand("job-job_1", "abc123def")).toBe(
      "git worktree add -- job-job_1 abc123def",
    )
    expect(() => jobWorktreeAddCommand("; rm -rf /")).toThrow(
      "invalid worktree name",
    )
    expect(commands.some((cmd) => cmd === "git add -A")).toBe(true)
    expect(commands.at(-1)).toBe("git worktree remove --force -- job-job_1")
    expect(commands.some((cmd) => /\bgit commit\b/.test(cmd))).toBe(false)
    expect(commands.some((cmd) => /\bgit push\b/.test(cmd))).toBe(false)
    expect(files.get("job-job_1/knowledge/a.md")).toBe("hello")
    expect(result).toEqual({
      files: [{ path: "knowledge/a.md", content: "hello" }],
      deletePaths: ["knowledge/gone.md"],
    })
  })

  it("lets an attached agent write extra files, then the runner collects them", async () => {
    const { fs } = memoryFs()
    const result = await runJobWorktree({
      worktree: "job-job_2",
      files: [],
      exec: async (command) => {
        if (command.includes("status --porcelain")) {
          return {
            stdout: "A  knowledge/new.md\n",
            stderr: "",
            exitCode: 0,
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      fs,
      agent: async (worktreePath) => {
        await fs.write(`${worktreePath}/knowledge/new.md`, "from agent")
      },
    })
    expect(result.files).toEqual([
      { path: "knowledge/new.md", content: "from agent" },
    ])
  })

  it("falls back to GitHub API when no job sandbox handle is attached", async () => {
    const planned = [{ path: "knowledge/a.md", content: "x" }]
    const result = await applyJobWorktreeIfPresent({
      worktree: { spawn: true, worktree: "job-job_1" },
      kind: "extract_ingest",
      files: planned,
      deletePaths: [],
      sandbox: null,
    })
    expect(result).toEqual({
      files: planned,
      deletePaths: [],
      via: "github_api",
    })
  })

  it("uses the worktree when a handle is present", async () => {
    const { fs } = memoryFs()
    const exec = vi.fn(async (command: string) => {
      if (command.includes("status --porcelain")) {
        return {
          stdout: "A  knowledge/a.md\n",
          stderr: "",
          exitCode: 0,
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })
    const result = await applyJobWorktreeIfPresent({
      worktree: { spawn: true, worktree: "job-job_1" },
      kind: "claims_upgrade",
      files: [{ path: "knowledge/a.md", content: "x" }],
      deletePaths: [],
      sandbox: { exec, fs },
    })
    expect(result.via).toBe("worktree")
    expect(result.files).toEqual([{ path: "knowledge/a.md", content: "x" }])
    expect(exec).toHaveBeenCalled()
  })

  it("checks out the remote tip before a semantic-merge worktree agent", async () => {
    const { fs, files } = memoryFs()
    const commands: string[] = []
    const exec = vi.fn(async (command: string) => {
      commands.push(command)
      if (command.startsWith("git cat-file -t ")) {
        return { stdout: "commit\n", stderr: "", exitCode: 0 }
      }
      if (command.includes("status --porcelain")) {
        return {
          stdout: "A  knowledge/a.md\n",
          stderr: "",
          exitCode: 0,
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })
    const result = await applyJobWorktreeIfPresent({
      worktree: { spawn: true, worktree: "job-job_1" },
      kind: "semantic_merge",
      files: [{ path: "knowledge/a.md", content: "merged" }],
      deletePaths: ["knowledge/gone.md"],
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
      sandbox: { exec, fs },
      turn: async (prompt) => {
        expect(prompt).toContain("failed job candidate")
        expect(prompt).toContain("FILE knowledge/a.md")
        expect(files.has("job-job_1/knowledge/a.md")).toBe(false)
        return '{"files":[{"path":"knowledge/a.md","content":"merged"}],"deletePaths":[]}'
      },
    })
    expect(result.via).toBe("worktree")
    expect(commands).toContain("git cat-file -t aaa1111")
    expect(commands).toContain("git cat-file -t bbb2222")
    expect(commands).toContain("git worktree add -- job-job_1 bbb2222")
  })

  it("refuses a GitHub API fallback for semantic merge", async () => {
    await expect(
      applyJobWorktreeIfPresent({
        worktree: { spawn: true, worktree: "job-job_1" },
        kind: "semantic_merge",
        files: [{ path: "knowledge/a.md", content: "merged" }],
        deletePaths: [],
        conflictParentSha: "aaa1111",
        remoteTipSha: "bbb2222",
        sandbox: null,
      }),
    ).rejects.toThrow("semantic merge requires both trees in the job worktree")
  })
})
