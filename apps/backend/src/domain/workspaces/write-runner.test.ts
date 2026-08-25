import { describe, expect, it } from "vitest"
import {
  capturedWriteParentSha,
  casCommitParents,
  executeWorkspaceWriteCommit,
  isNonFastForwardGithubError,
  jobCommitPath,
  jobUsesInSandboxWorktree,
  jobWorktreeName,
  livePushRecheck,
  persistJobCommitIfRemoteHasSha,
  planAfterCasRejection,
  planAfterMechanicalPushFailure,
  planJobWorktree,
  planWorkspaceWriteCommit,
  runnerCommitMessage,
  runnerMayPush,
  semanticMergeCommitParent,
  shouldEnqueueSemanticMergeOnPushFailure,
  shouldSpawnJobWorktree,
  workspaceWriteSandboxId,
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

  it("refuses a live push when generation or URL moved", () => {
    expect(
      livePushRecheck({
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 2,
        jobWorkspaceUrl: "https://github.com/acme/old",
        desiredWorkspaceUrl: "https://github.com/acme/new",
        defaultBranch: "main",
        targetBranch: "main",
      }).push,
    ).toBe(false)
    expect(
      livePushRecheck({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
        jobWorkspaceUrl: "https://github.com/acme/docs",
        desiredWorkspaceUrl: "https://github.com/acme/docs",
        defaultBranch: "develop",
        targetBranch: "develop",
      }),
    ).toEqual({ push: true })
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
    expect(jobWorktreeName("x; rm -rf /")).toBe("job-xrm-rf")
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
    const unlink = planWorkspaceWriteCommit({
      ...gate,
      files: [],
      deletePaths: ["repositories/billing.md"],
      existing: new Map([["repositories/billing.md", "---\ngit: x\n---\n"]]),
    })
    expect(unlink).toMatchObject({
      action: "commit",
      deletePaths: ["repositories/billing.md"],
    })
    const deletionOnly = planWorkspaceWriteCommit({
      ...gate,
      kind: "semantic_merge",
      files: [],
      deletePaths: ["knowledge/gone.md"],
      existing: new Map(),
    })
    expect(deletionOnly).toMatchObject({
      action: "commit",
      deletePaths: ["knowledge/gone.md"],
    })
  })

  it("executes a planned commit through the injected pusher", async () => {
    const plan = planWorkspaceWriteCommit({
      writeStatus: "writable",
      jobGeneration: 1,
      desiredGeneration: 1,
      jobWorkspaceUrl: "https://github.com/acme/docs",
      desiredWorkspaceUrl: "https://github.com/acme/docs",
      defaultBranch: "main",
      targetBranch: "main",
      repoName: "docs",
      files: [{ path: "repositories/app.md", content: "x" }],
      existing: new Map(),
    })
    const result = await executeWorkspaceWriteCommit({
      plan,
      commit: async () => ({ commitSha: "sha1" }),
    })
    expect(result).toEqual({ committed: true, commitSha: "sha1" })
    await expect(
      executeWorkspaceWriteCommit({
        plan: { action: "skip", reason: "no_changes" },
        commit: async () => ({ commitSha: "nope" }),
      }),
    ).resolves.toEqual({ committed: false, reason: "no_changes" })
  })

  it("keys the write sandbox by org, Workspace, generation, and URL", () => {
    expect(
      workspaceWriteSandboxId({
        orgId: "org_1",
        workspaceId: "ws_1",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        desiredGeneration: 2,
      }),
    ).toBe("org_1:ws_1:2:https://github.com/acme/docs:write")
    expect(
      shouldSpawnJobWorktree({
        writeStatus: "unknown",
        runningJobCount: 0,
        maxConcurrent: 4,
      }),
    ).toBe(false)
    expect(
      shouldSpawnJobWorktree({
        writeStatus: "writable",
        runningJobCount: 4,
        maxConcurrent: 4,
      }),
    ).toBe(false)
    expect(jobUsesInSandboxWorktree("semantic_merge")).toBe(true)
    expect(jobUsesInSandboxWorktree("ui_file_edit")).toBe(false)
    expect(jobUsesInSandboxWorktree("migration_export")).toBe(false)
    expect(jobCommitPath({ kind: "ui_file_edit", provider: "docker" })).toBe(
      "github_api",
    )
    expect(
      jobCommitPath({ kind: "claims_upgrade", provider: "unsandboxed" }),
    ).toBe("github_api")
    expect(jobCommitPath({ kind: "semantic_merge", provider: "docker" })).toBe(
      "worktree",
    )
    expect(
      planJobWorktree({
        jobId: "job_1",
        kind: "semantic_merge",
        writeStatus: "writable",
        runningJobCount: 0,
        provider: "docker",
      }),
    ).toEqual({ spawn: true, worktree: "job-job_1" })
    expect(
      planJobWorktree({
        jobId: "job_1",
        kind: "ui_file_edit",
        writeStatus: "writable",
        runningJobCount: 0,
        provider: "docker",
      }),
    ).toEqual({ spawn: false, reason: "mechanical_github_api" })
    expect(
      planJobWorktree({
        jobId: "job_1",
        kind: "link_unlink",
        writeStatus: "writable",
        runningJobCount: 0,
        provider: "docker",
      }).spawn,
    ).toBe(false)
  })

  it("captures the write parent SHA and enqueues semantic merge after CAS rejection", () => {
    expect(capturedWriteParentSha("abc")).toBe("abc")
    expect(capturedWriteParentSha("  ")).toBeNull()
    expect(capturedWriteParentSha(null)).toBeNull()
    expect(casCommitParents("abc")).toEqual(["abc"])
    expect(planAfterCasRejection()).toBe("enqueue_semantic_merge")
    expect(
      semanticMergeCommitParent({
        kind: "extract_ingest",
        capturedParentSha: "old",
        remoteTipSha: "new",
      }),
    ).toBe("old")
    expect(
      semanticMergeCommitParent({
        kind: "semantic_merge",
        capturedParentSha: "old",
        remoteTipSha: "new",
      }),
    ).toBe("new")
  })

  it("enqueues semantic merge after CAS rejection on a captured parent", () => {
    expect(
      shouldEnqueueSemanticMergeOnPushFailure({
        kind: "extract_ingest",
        nonFastForward: true,
        capturedParentSha: "abc",
      }),
    ).toBe(true)
    expect(
      shouldEnqueueSemanticMergeOnPushFailure({
        kind: "extract_ingest",
        nonFastForward: true,
        capturedParentSha: null,
      }),
    ).toBe(false)
    expect(
      shouldEnqueueSemanticMergeOnPushFailure({
        kind: "connector_mirror",
        nonFastForward: true,
        capturedParentSha: null,
      }),
    ).toBe(false)
    expect(
      shouldEnqueueSemanticMergeOnPushFailure({
        kind: "connector_mirror",
        nonFastForward: true,
        capturedParentSha: "abc",
      }),
    ).toBe(true)
  })

  it("enqueues semantic merge only after a mechanical-mirror non-FF", () => {
    expect(
      isNonFastForwardGithubError({
        status: 422,
        message: "Update is not a fast forward",
      }),
    ).toBe(true)
    expect(
      planAfterMechanicalPushFailure({
        kind: "connector_mirror",
        nonFastForward: true,
      }),
    ).toBe("enqueue_semantic_merge")
    expect(
      planAfterMechanicalPushFailure({
        kind: "migration_export",
        nonFastForward: true,
      }),
    ).toBe("fail_job")
  })
})
