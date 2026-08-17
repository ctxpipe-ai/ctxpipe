import { describe, expect, it, vi } from "vitest"
import {
  executeSemanticMergeTool,
  gitShowCommand,
  parseSemanticMergeJson,
  parseSemanticMergeTurn,
  parseWriteJobAgentFiles,
  parseWriteJobAgentResult,
  planWriteJobAgent,
  runSemanticMergeToolLoop,
  runWriteJobAgent,
  semanticMergeGitDiffCommand,
  semanticMergeTreeShas,
  writeJobAgentPrompt,
} from "./write-job-agent.js"

describe("write-job agents", () => {
  it("attaches to the existing job sandbox instead of calling withSandbox", () => {
    expect(
      planWriteJobAgent({
        kind: "extract_ingest",
        plannedFileCount: 0,
        hasJobSandbox: true,
      }),
    ).toEqual({ action: "run_agent" })
    expect(
      planWriteJobAgent({
        kind: "semantic_merge",
        plannedFileCount: 2,
        hasJobSandbox: true,
      }),
    ).toEqual({ action: "run_agent" })
    expect(
      planWriteJobAgent({
        kind: "claims_upgrade",
        plannedFileCount: 2,
        hasJobSandbox: true,
      }),
    ).toEqual({ action: "write_planned" })
    expect(
      planWriteJobAgent({
        kind: "extract_ingest",
        plannedFileCount: 0,
        hasJobSandbox: false,
      }),
    ).toEqual({ action: "github_api" })
    expect(
      planWriteJobAgent({
        kind: "migration_export",
        plannedFileCount: 1,
        hasJobSandbox: true,
      }),
    ).toEqual({ action: "github_api" })
  })

  it("writes generated files into the worktree and never calls withSandbox", async () => {
    const withSandbox = vi.fn()
    const written = new Map<string, string>()
    await runWriteJobAgent({
      kind: "extract_ingest",
      worktreePath: "job-job_1",
      withSandbox,
      fs: {
        write: async (path, data) => {
          written.set(path, data)
        },
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
      generate: async () => [
        { path: "knowledge/imported/note.md", content: "ingested" },
      ],
    })
    expect(withSandbox).not.toHaveBeenCalled()
    expect(written.get("job-job_1/knowledge/imported/note.md")).toBe("ingested")
  })

  it("parses generated file JSON and ignores garbage", () => {
    expect(
      parseWriteJobAgentFiles(
        '```json\n[{"path":"knowledge/a.md","content":"hi"}]\n```',
      ),
    ).toEqual([{ path: "knowledge/a.md", content: "hi" }])
    expect(parseWriteJobAgentFiles("not json")).toEqual([])
  })

  it("includes the conflicting commit and new remote tip for semantic merge", () => {
    const prompt = writeJobAgentPrompt({
      kind: "semantic_merge",
      worktreePath: "job-job_1",
      conflictParentSha: "aaa",
      remoteTipSha: "bbb",
      mergeFiles: [{ path: "knowledge/a.md", content: "ours" }],
    })
    expect(prompt).toContain("aaa")
    expect(prompt).toContain("bbb")
    expect(prompt).toContain("semantic_merge")
    expect(prompt).toContain("git_diff")
    expect(prompt).toContain("new remote tip")
    expect(prompt).toContain("failed job candidate")
    expect(prompt).toContain("FILE knowledge/a.md")
    expect(prompt).not.toContain("checked out at the captured parent")
    expect(semanticMergeGitDiffCommand("aaa1111", "bbb2222")).toBe(
      "git diff aaa1111 bbb2222",
    )
    expect(semanticMergeGitDiffCommand("not-a-sha", "bbb")).toBeNull()
    expect(
      semanticMergeTreeShas({
        conflictParentSha: "aaa1111",
        remoteTipSha: "bbb2222",
      }),
    ).toEqual({
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
    })
    expect(() =>
      semanticMergeTreeShas({
        conflictParentSha: "aaa1111",
        remoteTipSha: "aaa1111",
      }),
    ).toThrow("semantic merge requires both trees in the job worktree")
    expect(() =>
      semanticMergeTreeShas({
        conflictParentSha: null,
        remoteTipSha: "bbb2222",
      }),
    ).toThrow("semantic merge requires both trees in the job worktree")
    expect(gitShowCommand("aaa1111", "knowledge/a.md")).toBe(
      "git show aaa1111:knowledge/a.md",
    )
    expect(gitShowCommand("aaa1111", "../secret")).toBeNull()
    expect(gitShowCommand("aaa1111", "knowledge/a.md;rm")).toBeNull()
  })

  it("parses files plus deletePaths and TOOL turns", () => {
    expect(
      parseWriteJobAgentResult(
        '{"files":[{"path":"knowledge/a.md","content":"hi"}],"deletePaths":["knowledge/gone.md"]}',
      ),
    ).toEqual({
      files: [{ path: "knowledge/a.md", content: "hi" }],
      deletePaths: ["knowledge/gone.md"],
    })
    expect(
      parseSemanticMergeTurn(
        "TOOL git_diff\nTOOL read_file path=knowledge/a.md\nTOOL git_show sha=abc123 path=knowledge/a.md",
      ),
    ).toEqual([
      { name: "git_diff", args: {} },
      { name: "read_file", args: { path: "knowledge/a.md" } },
      { name: "git_show", args: { sha: "abc123", path: "knowledge/a.md" } },
    ])
    expect(
      parseSemanticMergeJson(
        '{"files":[{"path":"knowledge/a.md","content":"hi"}],"deletePaths":[]}',
      ),
    ).toEqual({
      files: [{ path: "knowledge/a.md", content: "hi" }],
      deletePaths: [],
    })
    expect(parseSemanticMergeJson("{}")).toBeNull()
    expect(parseSemanticMergeJson("[]")).toBeNull()
    expect(parseSemanticMergeJson('{"files":[]}')).toBeNull()
  })

  it("runs a semantic-merge tool loop then writes and deletes", async () => {
    const written = new Map<string, string>()
    const removed: string[] = []
    const commands: string[] = []
    let turns = 0
    await runSemanticMergeToolLoop({
      worktreePath: "job-job_1",
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
      exec: async (command) => {
        commands.push(command)
        if (command.startsWith("git cat-file -t ")) {
          return { stdout: "commit", stderr: "", exitCode: 0 }
        }
        return { stdout: "diff", stderr: "", exitCode: 0 }
      },
      fs: {
        write: async () => undefined,
        read: async () => "body",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
      turn: async () => {
        turns += 1
        if (turns === 1)
          return "TOOL git_diff\nTOOL read_file path=knowledge/a.md"
        return '{"files":[{"path":"knowledge/a.md","content":"merged"}],"deletePaths":["knowledge/gone.md"]}'
      },
    }).then(async (result) => {
      expect(result).toEqual({
        files: [{ path: "knowledge/a.md", content: "merged" }],
        deletePaths: ["knowledge/gone.md"],
      })
    })
    expect(commands[0]).toBe("git cat-file -t aaa1111")
    expect(commands).toContain("git diff aaa1111 bbb2222")
    expect(turns).toBe(2)

    await runWriteJobAgent({
      kind: "semantic_merge",
      worktreePath: "job-job_1",
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
      exec: async (command) => {
        if (command.startsWith("git cat-file -t ")) {
          return { stdout: "commit", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      fs: {
        write: async (path, data) => {
          written.set(path, data)
        },
        read: async () => "",
        remove: async (path) => {
          removed.push(path)
        },
        mkdir: async () => undefined,
      },
      turn: async () =>
        '{"files":[{"path":"knowledge/a.md","content":"merged"}],"deletePaths":["knowledge/gone.md"]}',
    })
    expect(written.get("job-job_1/knowledge/a.md")).toBe("merged")
    expect(removed).toContain("job-job_1/knowledge/gone.md")
  })

  it("fetches a missing merge SHA before the first model turn", async () => {
    const commands: string[] = []
    const result = await runSemanticMergeToolLoop({
      worktreePath: "job-job_1",
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
      exec: async (command) => {
        commands.push(command)
        if (command === "git cat-file -t bbb2222") {
          return { stdout: "", stderr: "missing", exitCode: 1 }
        }
        if (command.startsWith("git cat-file -t ")) {
          return { stdout: "commit", stderr: "", exitCode: 0 }
        }
        if (command.startsWith("git fetch ")) {
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: "diff", stderr: "", exitCode: 0 }
      },
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
      turn: async (prompt) => {
        expect(prompt).toContain("# git_diff both trees")
        expect(prompt).toContain("diff")
        return '{"files":[],"deletePaths":[]}'
      },
    })
    expect(result).toEqual({ files: [], deletePaths: [] })
    expect(commands).toContain("git fetch --depth=1 origin bbb2222")
    expect(commands).toContain("git diff aaa1111 bbb2222")
  })

  it("throws when semantic merge cannot see both trees or git fails", async () => {
    await expect(
      runWriteJobAgent({
        kind: "semantic_merge",
        worktreePath: "job-job_1",
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        turn: async () => '{"files":[],"deletePaths":[]}',
      }),
    ).rejects.toThrow("semantic merge requires both trees in the job worktree")

    await expect(
      runSemanticMergeToolLoop({
        worktreePath: "job-job_1",
        conflictParentSha: "aaa1111",
        remoteTipSha: "bbb2222",
        exec: async (command) => {
          if (command.startsWith("git cat-file -t ")) {
            return { stdout: "commit", stderr: "", exitCode: 0 }
          }
          return { stdout: "", stderr: "diff failed", exitCode: 1 }
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        turn: async () => '{"files":[],"deletePaths":[]}',
      }),
    ).rejects.toThrow("diff failed")

    await expect(
      runSemanticMergeToolLoop({
        worktreePath: "job-job_1",
        conflictParentSha: "aaa1111",
        remoteTipSha: "bbb2222",
        exec: async (command) => {
          if (command.startsWith("git cat-file -t ")) {
            return { stdout: "commit", stderr: "", exitCode: 0 }
          }
          return { stdout: "diff", stderr: "", exitCode: 0 }
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        turn: async () => "not json",
      }),
    ).rejects.toThrow("semantic merge did not return JSON")

    await expect(
      runSemanticMergeToolLoop({
        worktreePath: "job-job_1",
        conflictParentSha: "aaa1111",
        remoteTipSha: "bbb2222",
        exec: async (command) => {
          if (command.startsWith("git cat-file -t ")) {
            return { stdout: "commit", stderr: "", exitCode: 0 }
          }
          return { stdout: "diff", stderr: "", exitCode: 0 }
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        turn: async () => "{}",
      }),
    ).rejects.toThrow("semantic merge did not return JSON")
  })

  it("executes git_diff in the job worktree", async () => {
    const result = await executeSemanticMergeTool({
      name: "git_diff",
      args: {},
      worktreePath: "job-job_1",
      conflictParentSha: "aaa1111",
      remoteTipSha: "bbb2222",
      exec: async (command, options) => {
        expect(command).toBe("git diff aaa1111 bbb2222")
        expect(options?.cwd).toBe("job-job_1")
        return { stdout: "both trees", stderr: "", exitCode: 0 }
      },
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    })
    expect(result).toBe("both trees")
  })
})
