import { describe, expect, it } from "vitest"
import {
  COMMIT_SUBJECT_MODEL,
  commitSubjectPrompt,
  generateCommitSubject,
} from "./commit-subject.js"

describe("commit subject", () => {
  it("uses a small in-code model and tiny file-name context", () => {
    expect(COMMIT_SUBJECT_MODEL).toBe("anthropic/claude-haiku-4-5")
    expect(
      commitSubjectPrompt({
        repoName: "docs",
        trigger: "claims_upgrade",
        fileNames: ["knowledge/a.md", "knowledge/b.md"],
      }),
    ).toContain("knowledge/a.md, knowledge/b.md")
  })

  it("keeps a clean LLM line and falls back on garbage or failure", async () => {
    await expect(
      generateCommitSubject({
        repoName: "docs",
        trigger: "migration_export",
        fileNames: ["knowledge/a.md"],
        generate: async () => "ctxpipe - Knowledge update of docs from export",
      }),
    ).resolves.toBe("ctxpipe - Knowledge update of docs from export")
    await expect(
      generateCommitSubject({
        repoName: "docs",
        trigger: "bootstrap",
        fileNames: ["AGENTS.md"],
        generate: async () => "bad\nsubject",
      }),
    ).resolves.toBe("ctxpipe - Knowledge update of docs from bootstrap")
    await expect(
      generateCommitSubject({
        repoName: "docs",
        fileNames: [],
        generate: async () => {
          throw new Error("timeout")
        },
      }),
    ).resolves.toBe("ctxpipe - Knowledge update of docs")
  })
})
