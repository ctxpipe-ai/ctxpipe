import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  patch: vi.fn(),
  captureTarget: vi.fn(),
  listPrs: vi.fn(),
  capturePrs: vi.fn(),
  ingest: vi.fn(),
  runWorkflowWithWorkerWake: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/github-pr-mirror.js", () => ({
  getGithubPrMirrorBinding: mocks.getBinding,
  patchGithubPrMirror: mocks.patch,
}))
vi.mock("../../domain/workspaces/capture-connector-mirror.js", () => ({
  captureConnectorMirrorTarget: mocks.captureTarget,
}))
vi.mock("../../services/github/pull-request-mirror/sync.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/github/pull-request-mirror/sync.js")
  >("../../services/github/pull-request-mirror/sync.js")
  return {
    ...actual,
    listGithubPullRequestNumbersForConfig: mocks.listPrs,
    captureGithubPullRequestsForConfig: mocks.capturePrs,
  }
})
vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: mocks.ingest,
}))
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflowWithWorkerWake,
}))

import { GITHUB_PR_MIRROR_COMMIT_BATCH } from "../../services/github/pull-request-mirror/sync.js"
import {
  enqueueGithubPrMirrorContent,
  githubPrMirrorContentIdempotencyKey,
  githubPrMirrorRepoKey,
  githubSyncContent,
} from "./github-sync-content.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const CONFIG_SHA = "a".repeat(40)

const binding = {
  enabled: true,
  setupPhase: "live",
  repositoryId: "repo_ctx",
  repositoryName: "acme/ctxpipe-context",
  githubConnectionId: "con_gh",
  connectionId: "con_gh",
  gitUrl: "https://github.com/acme/ctxpipe-context.git",
  branch: "main",
  lastContentCommitSha: null,
  lastContentLaunchToken: null,
  contentSyncGeneration: 1,
}

const captured = {
  workspaceId: "ws_1",
  revision: {
    workspaceId: "ws_1",
    generation: 1,
    remote: {
      url: "https://github.com/acme/ctxpipe-context.git",
      connectionId: "con_gh",
    },
    defaultBranch: "main",
    sha: CONFIG_SHA,
    access: "write-default" as const,
  },
  mirror: {
    provider: "github" as const,
    connectionId: "con_gh",
    repositoryId: "repo_ctx",
    configBlobSha: null,
  },
  config: `version: 1
source: github
pullRequests:
  repositories:
    - acme/api
  states:
    - merged
  includeDrafts: false
  maxPullRequestsPerRepository: 500
`,
}

function prNumbers(count: number) {
  return Array.from({ length: count }, (_, i) => i + 1)
}

function prFilesForNumbers(repository: string, numbers: number[]) {
  const [owner, repo] = repository.split("/")
  return numbers.map((number) => ({
    path: `github/pulls/${owner}/${repo}/${number}--${number * 10}.md`,
    content: `# PR ${number}\n`,
  }))
}

function captureBodyRuns(runs: StepRun[]) {
  return runs.filter((run) =>
    run.name.startsWith("mirror-github-pull-requests:"),
  )
}

function workflowYaml(repositories: string[]) {
  return `version: 1
source: github
pullRequests:
  repositories:
${repositories.map((name) => `    - ${name}`).join("\n")}
  states:
    - merged
  includeDrafts: false
  maxPullRequestsPerRepository: 500
`
}

type Publication = {
  spec: unknown
  files: Array<{ path: string }>
  jobId: string
  stepName: string
  revisionSha: string
  deletePaths: string[]
  mirror: {
    provider: string
    connectionId: string
    repositoryId: string
    configBlobSha: string | null
    contentSyncGeneration?: number
  }
}

type StepRun = {
  name: string
  result: unknown
}

function workflowStep(
  onPublish?: (publication: Publication) => Promise<unknown>,
) {
  const publications: Publication[] = []
  const runs: StepRun[] = []
  return {
    publications,
    runs,
    step: {
      run: async (
        options: { name: string },
        operation: () => Promise<unknown>,
      ) => {
        const result = await operation()
        runs.push({ name: options.name, result })
        return result
      },
      runWorkflow: async (
        spec: unknown,
        input: {
          files: Array<{ path: string }>
          jobId: string
          revision: { sha: string }
          deletePaths: string[]
          mirror: Publication["mirror"]
        },
        options: { name: string },
      ) => {
        const publication: Publication = {
          spec,
          files: input.files,
          jobId: input.jobId,
          stepName: options.name,
          revisionSha: input.revision.sha,
          deletePaths: input.deletePaths,
          mirror: input.mirror,
        }
        publications.push(publication)
        if (onPublish) return onPublish(publication)
        return {
          committed: true as const,
          commitSha: `sha_${publications.length}`,
        }
      },
    },
  }
}

async function runContent(
  step: unknown,
  runId = "run_1",
  input: {
    orgId?: string
    connectionId?: string
    contentSyncGeneration?: number
    commitSha?: string
    launchToken?: string
    repositoryId?: string
    branch?: string
  } = {},
) {
  return githubSyncContent.fn({
    step,
    input: {
      orgId: "org_1",
      connectionId: "con_gh",
      ...input,
    },
    run: { id: runId },
    version: null,
  } as never)
}

it("keys a content sync by connection and config commit", () => {
  expect(
    githubPrMirrorContentIdempotencyKey({
      connectionId: "con_github",
      commitSha: "sha_config",
    }),
  ).toBe("github-pr-mirror-content:con_github:sha_config")
  expect(
    githubPrMirrorContentIdempotencyKey({
      connectionId: "con_github",
      commitSha: "sha_config",
      launchToken: "tok_retry",
    }),
  ).toBe("github-pr-mirror-content:con_github:sha_config:launch:tok_retry")
})

describe("enqueueGithubPrMirrorContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 1 })
    mocks.runWorkflowWithWorkerWake.mockResolvedValue({
      workflowRun: { id: "run_pending", status: "pending" },
    })
  })

  it("records the commit SHA before starting the keyed run", async () => {
    await expect(
      enqueueGithubPrMirrorContent({
        orgId: "org_1",
        connectionId: "con_gh",
        commitSha: "sha_b",
      }),
    ).resolves.toEqual({ id: "run_pending", status: "pending" })
    expect(mocks.patch).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_gh",
      reserveContentLaunch: true,
      patch: {
        lastContentCommitSha: "sha_b",
        lastContentLaunchToken: null,
      },
    })
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      {
        orgId: "org_1",
        connectionId: "con_gh",
        contentSyncGeneration: 1,
        commitSha: "sha_b",
      },
      { idempotencyKey: "github-pr-mirror-content:con_gh:sha_b" },
    )
  })

  it("starts a new run when a launch token is provided instead of reusing a completed SHA marker", async () => {
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (_spec, _input, options?: { idempotencyKey?: string }) => {
        if (options?.idempotencyKey?.includes(":launch:tok_retry")) {
          return { workflowRun: { id: "run_fresh", status: "pending" } }
        }
        return { workflowRun: { id: "run_completed", status: "completed" } }
      },
    )

    await expect(
      enqueueGithubPrMirrorContent({
        orgId: "org_1",
        connectionId: "con_gh",
        commitSha: "sha_a",
      }),
    ).resolves.toEqual({ id: "run_completed", status: "completed" })
    await expect(
      enqueueGithubPrMirrorContent({
        orgId: "org_1",
        connectionId: "con_gh",
        commitSha: "sha_a",
        launchToken: "tok_retry",
      }),
    ).resolves.toEqual({ id: "run_fresh", status: "pending" })

    expect(mocks.patch).toHaveBeenLastCalledWith({
      orgId: "org_1",
      connectionId: "con_gh",
      reserveContentLaunch: true,
      patch: {
        lastContentCommitSha: "sha_a",
        lastContentLaunchToken: "tok_retry",
      },
    })
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubSyncContent.spec,
      {
        orgId: "org_1",
        connectionId: "con_gh",
        contentSyncGeneration: 1,
        commitSha: "sha_a",
        launchToken: "tok_retry",
      },
      {
        idempotencyKey:
          "github-pr-mirror-content:con_gh:sha_a:launch:tok_retry",
      },
    )
  })

  it("does not reserve a new generation for a repeated pending identity", async () => {
    mocks.patch
      .mockResolvedValueOnce({ applied: true, contentSyncGeneration: 4 })
      .mockResolvedValueOnce({ applied: true, contentSyncGeneration: 4 })

    await enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_same",
    })
    await enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_same",
    })

    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      1,
      githubSyncContent.spec,
      expect.objectContaining({
        contentSyncGeneration: 4,
        commitSha: "sha_same",
      }),
      { idempotencyKey: "github-pr-mirror-content:con_gh:sha_same" },
    )
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubSyncContent.spec,
      expect.objectContaining({
        contentSyncGeneration: 4,
        commitSha: "sha_same",
      }),
      { idempotencyKey: "github-pr-mirror-content:con_gh:sha_same" },
    )
  })
})

it("uses a collision-resistant digest of the exact repository string", () => {
  expect(githubPrMirrorRepoKey("a/b--c")).toBe("a--b--c-d3db2e148acfbeee")
  expect(githubPrMirrorRepoKey("a--b/c")).toBe("a--b--c-b78899b86a55d952")
  expect(githubPrMirrorRepoKey("a/b--c")).not.toBe(
    githubPrMirrorRepoKey("a--b/c"),
  )
})

describe("githubSyncContent publication batches", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBinding.mockResolvedValue(binding)
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 1 })
    mocks.captureTarget.mockResolvedValue(captured)
    mocks.ingest.mockResolvedValue({ workflowRunId: "run_ingest" })
    mocks.listPrs.mockImplementation(async () => ({
      numbers: prNumbers(GITHUB_PR_MIRROR_COMMIT_BATCH + 5),
    }))
    mocks.capturePrs.mockImplementation(
      async ({
        repository,
        numbers,
      }: {
        repository: string
        numbers: number[]
      }) => ({
        files: prFilesForNumbers(repository, numbers),
      }),
    )
  })

  it("publishes 205 files as two children and ingests once after both finish", async () => {
    let releaseSecond!: () => void
    const secondChild = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const { publications, runs, step } = workflowStep(async () => {
      if (publications.length === 1) {
        expect(mocks.ingest).not.toHaveBeenCalled()
      }
      if (publications.length === 2) {
        expect(mocks.ingest).not.toHaveBeenCalled()
        await secondChild
      }
      return {
        committed: true as const,
        commitSha: `sha_${publications.length}`,
      }
    })
    const finished = runContent(step)
    await vi.waitFor(() => {
      expect(publications).toHaveLength(2)
    })
    expect(mocks.ingest).not.toHaveBeenCalled()
    releaseSecond()
    await expect(finished).resolves.toEqual({
      written: GITHUB_PR_MIRROR_COMMIT_BATCH + 5,
      failedRepositories: [],
    })

    const bodyResults = captureBodyRuns(runs).map((run) => {
      const result = run.result as { files: unknown[] }
      return result.files.length
    })
    expect(bodyResults).toEqual([GITHUB_PR_MIRROR_COMMIT_BATCH, 5])
    expect(
      bodyResults.every((count) => count <= GITHUB_PR_MIRROR_COMMIT_BATCH),
    ).toBe(true)
    expect(
      mocks.capturePrs.mock.calls.every((call) => {
        const input = call[0] as { numbers: number[] }
        return input.numbers.length <= GITHUB_PR_MIRROR_COMMIT_BATCH
      }),
    ).toBe(true)

    expect(publications).toHaveLength(2)
    expect(publications[0]?.spec).toBe(workspaceConnectorMirror.spec)
    expect(publications.map((publication) => publication.files.length)).toEqual(
      [GITHUB_PR_MIRROR_COMMIT_BATCH, 5],
    )
    expect(publications[0]?.files[0]?.path).toBe(
      "github/pulls/acme/api/1--10.md",
    )
    expect(publications[1]?.files[0]?.path).toBe(
      `github/pulls/acme/api/${GITHUB_PR_MIRROR_COMMIT_BATCH + 1}--${(GITHUB_PR_MIRROR_COMMIT_BATCH + 1) * 10}.md`,
    )
    expect(publications[0]?.revisionSha).toBe(CONFIG_SHA)
    expect(publications[1]?.revisionSha).toBe("sha_1")
    expect(
      new Set(publications.map((publication) => publication.jobId)).size,
    ).toBe(2)
    expect(
      new Set(publications.map((publication) => publication.stepName)).size,
    ).toBe(2)
    expect(publications.map((publication) => publication.deletePaths)).toEqual([
      [],
      [],
    ])
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
    expect(mocks.ingest).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        repositoryId: "repo_ctx",
        targetBranch: "main",
        indexingReason: "Mirroring GitHub pull requests",
      },
      expect.objectContaining({ error: expect.any(Function) }),
    )
    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })

  it("keeps every multi-repo publication at or below 200 files", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["acme/api", "acme/web"]),
    })
    mocks.listPrs.mockImplementation(async () => ({
      numbers: prNumbers(150),
    }))

    const { publications, step } = workflowStep()
    await expect(runContent(step)).resolves.toEqual({
      written: 300,
      failedRepositories: [],
    })

    expect(publications).toHaveLength(2)
    expect(
      publications.every(
        (publication) =>
          publication.files.length <= GITHUB_PR_MIRROR_COMMIT_BATCH,
      ),
    ).toBe(true)
    expect(publications.map((publication) => publication.files.length)).toEqual(
      [150, 150],
    )
    expect(
      publications[0]?.files.every((file) =>
        file.path.startsWith("github/pulls/acme/api/"),
      ),
    ).toBe(true)
    expect(
      publications[1]?.files.every((file) =>
        file.path.startsWith("github/pulls/acme/web/"),
      ),
    ).toBe(true)
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
  })

  it("publishes the good repository when another repository fails", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["acme/api", "acme/broken"]),
    })
    mocks.listPrs.mockImplementation(
      async ({ repository }: { repository: string }) => {
        if (repository === "acme/broken") throw new Error("404 not found")
        return { numbers: prNumbers(3) }
      },
    )

    const { publications, step } = workflowStep()
    await expect(runContent(step)).rejects.toThrow(/acme\/broken/)
    expect(publications).toHaveLength(1)
    expect(publications[0]?.files).toHaveLength(3)
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })

  it("reaches live when a later run succeeds after a partial failure", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["acme/api", "acme/broken"]),
    })
    let failBroken = true
    mocks.listPrs.mockImplementation(
      async ({ repository }: { repository: string }) => {
        if (failBroken && repository === "acme/broken") {
          throw new Error("404 not found")
        }
        return { numbers: prNumbers(3) }
      },
    )

    const first = workflowStep()
    await expect(runContent(first.step)).rejects.toThrow(/acme\/broken/)
    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )

    failBroken = false
    const second = workflowStep()
    await expect(runContent(second.step)).resolves.toEqual({
      written: 6,
      failedRepositories: [],
    })
    expect(second.publications).toHaveLength(2)
    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
  })

  it("fails the backfill only when every repository failed", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["acme/api", "acme/web"]),
    })
    mocks.listPrs.mockRejectedValue(new Error("boom"))

    const { publications, step } = workflowStep()
    await expect(runContent(step)).rejects.toThrow(/every repository/)
    expect(publications).toHaveLength(0)
    expect(mocks.ingest).not.toHaveBeenCalled()
    expect(mocks.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })

  it("does not treat a parked mirror child as a failed sync", async () => {
    const sleep = new Error("park")
    sleep.name = "SleepSignal"
    const { step } = workflowStep(async () => {
      throw sleep
    })
    await expect(runContent(step)).rejects.toMatchObject({
      name: "SleepSignal",
    })
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
    expect(mocks.ingest).not.toHaveBeenCalled()
  })

  it("keeps colliding slash-dash repository names on distinct durable steps and files", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["a/b--c", "a--b/c"]),
    })
    mocks.listPrs.mockImplementation(async () => ({ numbers: prNumbers(2) }))

    const { publications, runs, step } = workflowStep()
    await expect(runContent(step)).resolves.toEqual({
      written: 4,
      failedRepositories: [],
    })

    const firstKey = "a--b--c-b78899b86a55d952"
    const secondKey = "a--b--c-d3db2e148acfbeee"
    expect(publications.map((publication) => publication.jobId)).toEqual([
      `wjob_run_1_mirror_${firstKey}_0`,
      `wjob_run_1_mirror_${secondKey}_0`,
    ])
    expect(publications.map((publication) => publication.stepName)).toEqual([
      `commit-github-pr-mirror:${firstKey}:0`,
      `commit-github-pr-mirror:${secondKey}:0`,
    ])
    expect(
      runs
        .map((run) => run.name)
        .filter((name) => name.includes("github-pull-requests:")),
    ).toEqual([
      `list-github-pull-requests:${firstKey}`,
      `mirror-github-pull-requests:${firstKey}:0`,
      `list-github-pull-requests:${secondKey}`,
      `mirror-github-pull-requests:${secondKey}:0`,
    ])
    expect(
      publications[0]?.files.every((file) =>
        file.path.startsWith("github/pulls/a--b/c/"),
      ),
    ).toBe(true)
    expect(
      publications[1]?.files.every((file) =>
        file.path.startsWith("github/pulls/a/b--c/"),
      ),
    ).toBe(true)
  })

  it("continues the next repository from a committed revision when a later batch fails", async () => {
    mocks.captureTarget.mockResolvedValue({
      ...captured,
      config: workflowYaml(["acme/api", "acme/web"]),
    })
    mocks.listPrs.mockImplementation(
      async ({ repository }: { repository: string }) => ({
        numbers:
          repository === "acme/api"
            ? prNumbers(GITHUB_PR_MIRROR_COMMIT_BATCH + 5)
            : prNumbers(3),
      }),
    )

    const { publications, runs, step } = workflowStep(async (publication) => {
      if (publication.stepName.endsWith(":1")) {
        throw new Error("second api batch failed")
      }
      return {
        committed: true as const,
        commitSha: `sha_${publications.length}`,
      }
    })
    await expect(runContent(step)).rejects.toThrow(/acme\/api/)
    expect(mocks.patch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )

    expect(publications).toHaveLength(3)
    expect(publications.map((publication) => publication.files.length)).toEqual(
      [GITHUB_PR_MIRROR_COMMIT_BATCH, 5, 3],
    )
    expect(
      captureBodyRuns(runs).every((run) => {
        const result = run.result as { files: unknown[] }
        return result.files.length <= GITHUB_PR_MIRROR_COMMIT_BATCH
      }),
    ).toBe(true)
    expect(publications[0]?.revisionSha).toBe(CONFIG_SHA)
    expect(
      publications[2]?.files.every((file) =>
        file.path.startsWith("github/pulls/acme/web/"),
      ),
    ).toBe(true)
    expect(publications[2]?.revisionSha).toBe("sha_1")
    expect(mocks.ingest).toHaveBeenCalledTimes(1)
  })
})

describe("githubSyncContent launch ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureTarget.mockResolvedValue(captured)
    mocks.ingest.mockResolvedValue({ workflowRunId: "run_ingest" })
    mocks.listPrs.mockImplementation(async () => ({ numbers: prNumbers(3) }))
    mocks.capturePrs.mockImplementation(
      async ({
        repository,
        numbers,
      }: {
        repository: string
        numbers: number[]
      }) => ({
        files: prFilesForNumbers(repository, numbers),
      }),
    )
  })

  it("lets a pre-marker legacy content run complete when no reserved owner exists", async () => {
    const store = {
      generation: 0,
      sha: null as string | null,
      token: null as string | null,
      phase: "draft" as string,
      owner: null as string | null,
      repositoryId: "repo_ctx",
      branch: "main",
    }
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      contentSyncGeneration: store.generation || 1,
      lastContentCommitSha: store.sha,
      lastContentLaunchToken: store.token,
      setupPhase: store.phase,
      repositoryId: store.repositoryId,
      branch: store.branch,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        claimContentRun?: boolean
        workflowRunId?: string
        expectedContentSyncGeneration?: number
        patch: { setupPhase?: string }
      }) => {
        const alreadyOwner =
          Boolean(input.workflowRunId) && store.owner === input.workflowRunId
        if (
          input.claimContentRun &&
          input.expectedContentSyncGeneration == null &&
          !alreadyOwner &&
          (store.sha != null ||
            store.token != null ||
            store.owner != null ||
            store.generation > 0)
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.claimContentRun &&
          input.expectedContentSyncGeneration == null
        ) {
          store.generation += 1
          store.owner = input.workflowRunId ?? store.owner
        }
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    const a = workflowStep()
    await expect(runContent(a.step, "run_legacy_a")).resolves.toEqual({
      written: 3,
      failedRepositories: [],
    })
    expect(a.publications).toHaveLength(1)
    expect(store).toMatchObject({
      generation: 1,
      sha: null,
      token: null,
      phase: "live",
      owner: "run_legacy_a",
    })
  })

  it("lets the later launch own terminal state when an earlier run finishes last", async () => {
    let currentGeneration = 0
    const appliedPhases: Array<{ generation: number; phase: string }> = []
    const aAfterClaim = deferred()
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      contentSyncGeneration: currentGeneration || 1,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        claimContentRun?: boolean
        expectedContentSyncGeneration?: number
        patch: { setupPhase?: string }
      }) => {
        if (input.claimContentRun) {
          const generation = ++currentGeneration
          if (generation === 1) await aAfterClaim.promise
          return { applied: true, contentSyncGeneration: generation }
        }
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== currentGeneration
        ) {
          return { applied: false, contentSyncGeneration: currentGeneration }
        }
        if (input.patch.setupPhase) {
          appliedPhases.push({
            generation:
              input.expectedContentSyncGeneration ?? currentGeneration,
            phase: input.patch.setupPhase,
          })
        }
        return { applied: true, contentSyncGeneration: currentGeneration }
      },
    )

    const a = workflowStep()
    const b = workflowStep()
    const aFinished = runContent(a.step, "run_a")
    await vi.waitFor(() => {
      expect(currentGeneration).toBe(1)
    })
    await expect(runContent(b.step, "run_b")).resolves.toEqual({
      written: 3,
      failedRepositories: [],
    })
    aAfterClaim.resolve()
    await expect(aFinished).resolves.toEqual({
      written: 0,
      failedRepositories: [],
      status: "superseded",
    })

    expect(a.publications).toHaveLength(0)
    expect(b.publications).toHaveLength(1)
    expect(appliedPhases).toEqual([{ generation: 2, phase: "live" }])
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSyncGeneration: 1,
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSyncGeneration: 1,
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })

  it("supersedes a stalled earlier helper after a later launch completes", async () => {
    const store = {
      generation: 0,
      sha: null as string | null,
      token: null as string | null,
      phase: "draft" as string,
      repositoryId: "repo_ctx",
      branch: "main",
    }
    const aAfterReserve = deferred()
    let reservedA = false
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      contentSyncGeneration: store.generation || 1,
      lastContentCommitSha: store.sha,
      lastContentLaunchToken: store.token,
      setupPhase: store.phase,
      repositoryId: store.repositoryId,
      branch: store.branch,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        reserveContentLaunch?: boolean
        claimContentRun?: boolean
        expectedContentSyncGeneration?: number
        expectedRepositoryId?: string
        expectedBranch?: string
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
          setupPhase?: string
        }
      }) => {
        if (input.reserveContentLaunch) {
          const sameIdentity =
            store.sha === (input.patch.lastContentCommitSha ?? null) &&
            store.token === (input.patch.lastContentLaunchToken ?? null)
          if (!sameIdentity) {
            store.generation += 1
            store.sha = input.patch.lastContentCommitSha ?? null
            store.token = input.patch.lastContentLaunchToken ?? null
          }
          const generation = store.generation
          if (input.patch.lastContentCommitSha === "sha_a" && !reservedA) {
            reservedA = true
            await aAfterReserve.promise
          }
          return {
            applied: true,
            contentSyncGeneration: generation,
            repositoryId: store.repositoryId,
            branch: store.branch,
          }
        }
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedRepositoryId != null &&
          input.expectedRepositoryId !== store.repositoryId
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedBranch != null &&
          input.expectedBranch !== store.branch
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimContentRun) {
          if (input.patch.setupPhase) store.phase = input.patch.setupPhase
          return {
            applied: true,
            contentSyncGeneration: store.generation,
            repositoryId: store.repositoryId,
            branch: store.branch,
          }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    const aEnqueue = enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_a",
    })
    await vi.waitFor(() => {
      expect(store).toMatchObject({ generation: 1, sha: "sha_a" })
    })
    const bHandle = await enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_b",
    })
    expect(bHandle).toEqual({ id: "run_pending", status: "pending" })
    expect(store).toMatchObject({ generation: 2, sha: "sha_b" })

    const b = workflowStep()
    await expect(
      runContent(b.step, "run_b", {
        contentSyncGeneration: 2,
        commitSha: "sha_b",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toEqual({ written: 3, failedRepositories: [] })
    expect(store.phase).toBe("live")

    aAfterReserve.resolve()
    const aHandle = await aEnqueue
    expect(aHandle).toEqual({ id: "run_pending", status: "pending" })
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({
        contentSyncGeneration: 1,
        commitSha: "sha_a",
      }),
      { idempotencyKey: "github-pr-mirror-content:con_gh:sha_a" },
    )

    const a = workflowStep()
    await expect(
      runContent(a.step, "run_a", {
        contentSyncGeneration: 1,
        commitSha: "sha_a",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toEqual({
      written: 0,
      failedRepositories: [],
      status: "superseded",
    })
    expect(a.publications).toHaveLength(0)
    expect(b.publications).toHaveLength(1)
    expect(store).toMatchObject({
      generation: 2,
      sha: "sha_b",
      phase: "live",
    })
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSyncGeneration: 1,
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
  })

  it("supersedes a retained legacy claim after a reserved identity is live", async () => {
    const store = {
      generation: 0,
      sha: null as string | null,
      token: null as string | null,
      phase: "draft" as string,
      owner: null as string | null,
      repositoryId: "repo_ctx",
      branch: "main",
    }
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      contentSyncGeneration: store.generation || 1,
      lastContentCommitSha: store.sha,
      lastContentLaunchToken: store.token,
      setupPhase: store.phase,
      repositoryId: store.repositoryId,
      branch: store.branch,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        reserveContentLaunch?: boolean
        claimContentRun?: boolean
        workflowRunId?: string
        expectedContentSyncGeneration?: number
        expectedRepositoryId?: string
        expectedBranch?: string
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
          setupPhase?: string
        }
      }) => {
        if (input.reserveContentLaunch) {
          const sameIdentity =
            store.sha === (input.patch.lastContentCommitSha ?? null) &&
            store.token === (input.patch.lastContentLaunchToken ?? null)
          if (!sameIdentity) {
            store.generation += 1
            store.sha = input.patch.lastContentCommitSha ?? null
            store.token = input.patch.lastContentLaunchToken ?? null
            store.owner = null
          }
          return {
            applied: true,
            contentSyncGeneration: store.generation,
            repositoryId: store.repositoryId,
            branch: store.branch,
          }
        }
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedRepositoryId != null &&
          input.expectedRepositoryId !== store.repositoryId
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedBranch != null &&
          input.expectedBranch !== store.branch
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimContentRun) {
          const alreadyOwner =
            Boolean(input.workflowRunId) && store.owner === input.workflowRunId
          if (
            input.expectedContentSyncGeneration == null &&
            !alreadyOwner &&
            (store.sha != null ||
              store.token != null ||
              store.owner != null ||
              store.generation > 0)
          ) {
            return { applied: false, contentSyncGeneration: store.generation }
          }
          if (input.patch.setupPhase) store.phase = input.patch.setupPhase
          store.owner = input.workflowRunId ?? store.owner
          return {
            applied: true,
            contentSyncGeneration: store.generation,
            repositoryId: store.repositoryId,
            branch: store.branch,
          }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    await enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_b",
      launchToken: "tok_b",
    })
    const b = workflowStep()
    await expect(
      runContent(b.step, "run_b", {
        contentSyncGeneration: 1,
        commitSha: "sha_b",
        launchToken: "tok_b",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toEqual({ written: 3, failedRepositories: [] })
    expect(store).toMatchObject({
      generation: 1,
      sha: "sha_b",
      token: "tok_b",
      phase: "live",
    })

    const a = workflowStep()
    await expect(runContent(a.step, "run_legacy_a")).resolves.toEqual({
      written: 0,
      failedRepositories: [],
      status: "superseded",
    })
    expect(a.publications).toHaveLength(0)
    expect(b.publications).toHaveLength(1)
    expect(store).toMatchObject({
      generation: 1,
      sha: "sha_b",
      token: "tok_b",
      phase: "live",
    })
  })

  it("does not let a claimed run publish or mark a rebound target live", async () => {
    const store = {
      generation: 2,
      phase: "draft" as string,
      repositoryId: "repo_r2",
      branch: "main",
    }
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      contentSyncGeneration: store.generation,
      repositoryId: store.repositoryId,
      branch: store.branch,
      setupPhase: store.phase,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        claimContentRun?: boolean
        expectedContentSyncGeneration?: number
        expectedRepositoryId?: string
        expectedBranch?: string
        patch: { setupPhase?: string }
      }) => {
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedRepositoryId != null &&
          input.expectedRepositoryId !== store.repositoryId
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (
          input.expectedBranch != null &&
          input.expectedBranch !== store.branch
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimContentRun) {
          if (input.patch.setupPhase) store.phase = input.patch.setupPhase
          return {
            applied: true,
            contentSyncGeneration: store.generation,
            repositoryId: store.repositoryId,
            branch: store.branch,
          }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    const a = workflowStep()
    await expect(
      runContent(a.step, "run_r1", {
        contentSyncGeneration: 1,
        repositoryId: "repo_r1",
        branch: "main",
      }),
    ).resolves.toEqual({
      written: 0,
      failedRepositories: [],
      status: "superseded",
    })
    expect(a.publications).toHaveLength(0)
    expect(store).toMatchObject({
      generation: 2,
      repositoryId: "repo_r2",
      phase: "draft",
    })
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
    expect(mocks.captureTarget).not.toHaveBeenCalled()
    expect(mocks.ingest).not.toHaveBeenCalled()
  })

  it("carries the claimed contentSyncGeneration into each immutable mirror child", async () => {
    mocks.getBinding.mockResolvedValue({
      ...binding,
      contentSyncGeneration: 4,
    })
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 4 })
    const { publications, step } = workflowStep()
    await expect(
      runContent(step, "run_gen", { contentSyncGeneration: 4 }),
    ).resolves.toEqual({ written: 3, failedRepositories: [] })
    expect(publications).toHaveLength(1)
    expect(publications[0]?.mirror).toEqual({
      provider: "github",
      connectionId: "con_gh",
      repositoryId: "repo_ctx",
      configBlobSha: null,
      contentSyncGeneration: 4,
    })
  })

  it("rejects a stale content child after a newer launch publishes", async () => {
    const { assertConnectorMirrorBinding } = await import(
      "../../domain/workspaces/connector-mirror.js"
    )
    const store = {
      generation: 1,
      phase: "initial_sync" as string,
    }
    const aAfterParentCheck = deferred()
    const releaseAChild = deferred()
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      orgId: "org_1",
      contentSyncGeneration: store.generation,
      setupPhase: store.phase,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        claimContentRun?: boolean
        expectedContentSyncGeneration?: number
        patch: { setupPhase?: string }
      }) => {
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimContentRun) {
          if (input.patch.setupPhase) store.phase = input.patch.setupPhase
          return { applied: true, contentSyncGeneration: store.generation }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    const a = workflowStep(async (publication) => {
      aAfterParentCheck.resolve()
      await releaseAChild.promise
      await assertConnectorMirrorBinding(
        "org_1",
        publication.mirror as never,
        captured.revision,
      )
      return { committed: true as const, commitSha: "sha_stale_a" }
    })
    const aFinished = runContent(a.step, "run_a", { contentSyncGeneration: 1 })
    await aAfterParentCheck.promise

    store.generation = 2
    store.phase = "live"
    const b = workflowStep(async (publication) => {
      await assertConnectorMirrorBinding(
        "org_1",
        publication.mirror as never,
        captured.revision,
      )
      return { committed: true as const, commitSha: "sha_b" }
    })
    await expect(
      runContent(b.step, "run_b", { contentSyncGeneration: 2 }),
    ).resolves.toEqual({ written: 3, failedRepositories: [] })
    expect(b.publications).toHaveLength(1)
    expect(b.publications[0]?.mirror.contentSyncGeneration).toBe(2)

    releaseAChild.resolve()
    await expect(aFinished).rejects.toThrow(/acme\/api/)
    expect(a.publications).toHaveLength(1)
    expect(a.publications[0]?.mirror.contentSyncGeneration).toBe(1)
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSyncGeneration: 1,
        patch: expect.objectContaining({ setupPhase: "live" }),
      }),
    )
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        expectedContentSyncGeneration: 2,
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
    expect(store).toMatchObject({ generation: 2, phase: "live" })
  })
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
