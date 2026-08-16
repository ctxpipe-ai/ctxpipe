import { describe, expect, it, vi } from "vitest"
import {
  parseWriteJobAgentFiles,
  planWriteJobAgent,
  runWriteJobAgent,
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
        plannedFileCount: 0,
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
    })
    expect(prompt).toContain("aaa")
    expect(prompt).toContain("bbb")
    expect(prompt).toContain("semantic_merge")
  })
})
