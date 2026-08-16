import { describe, expect, it } from "vitest"
import {
  jobWorktreeName,
  persistJobCommitIfRemoteHasSha,
  planWorkspaceWriteCommit,
  runnerCommitMessage,
  runnerMayPush,
} from "./write-runner.js"

describe("write runner", () => {
  it("uses the LLM subject when it is a single clean line", () => {
    expect(
      runnerCommitMessage({
        repoName: "docs",
        llmSubject: "ctxpipe - Knowledge update of docs from confluence",
      }),
    ).toBe("ctxpipe - Knowledge update of docs from confluence")
    expect(
      runnerCommitMessage({ repoName: "docs", llmSubject: "bad\nsubject" }),
    ).toBe("ctxpipe - Knowledge update of docs")
  })

  it("pushes only the default branch of the current generation", () => {
    expect(
      runnerMayPush({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
        jobWorkspaceUrl: "https://github.com/acme/b",
        desiredWorkspaceUrl: "https://github.com/acme/b",
        defaultBranch: "develop",
        targetBranch: "develop",
      }),
    ).toEqual({ push: true })
    expect(
      runnerMayPush({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
        jobWorkspaceUrl: "https://github.com/acme/b",
        desiredWorkspaceUrl: "https://github.com/acme/b",
        defaultBranch: "develop",
        targetBranch: "main",
      }).push,
    ).toBe(false)
  })

  it("skips recommit when the remote already has the job SHA", () => {
    expect(
      persistJobCommitIfRemoteHasSha({
        recordedCommit: "abc",
        remoteSha: "abc",
      }),
    ).toBe("skip_push_and_hydrate")
    expect(jobWorktreeName("job_1")).toBe("job-job_1")
  })

  it("skips a no-op commit and plans a one-commit push on the default branch", () => {
    const gate = {
      writeStatus: "writable",
      jobGeneration: 1,
      desiredGeneration: 1,
      jobWorkspaceUrl: "https://github.com/acme/docs",
      desiredWorkspaceUrl: "https://github.com/acme/docs",
      defaultBranch: "main",
      targetBranch: "main",
      repoName: "docs",
    }
    expect(
      planWorkspaceWriteCommit({
        ...gate,
        files: [{ path: "knowledge/imported/a.md", content: "same" }],
        existing: new Map([["knowledge/imported/a.md", "same"]]),
      }),
    ).toEqual({ action: "skip", reason: "no_changes" })
    const planned = planWorkspaceWriteCommit({
      ...gate,
      files: [
        {
          path: "repositories/app.md",
          content: "---\ngit: https://github.com/acme/app.git\n---\n",
        },
      ],
      existing: new Map(),
      llmSubject: "ctxpipe - Knowledge update of docs from migration",
    })
    expect(planned.action).toBe("commit")
    if (planned.action === "commit") {
      expect(planned.files).toHaveLength(1)
      expect(planned.message).toBe(
        "ctxpipe - Knowledge update of docs from migration",
      )
    }
  })
})
