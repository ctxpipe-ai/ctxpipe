import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  bind: vi.fn(),
  getBinding: vi.fn(),
  patch: vi.fn(),
  listReposForOrg: vi.fn(),
  loadConfig: vi.fn(),
  capture: vi.fn(),
  listGithubConnections: vi.fn(),
  runWorkflowWithWorkerWake: vi.fn(),
}))

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../../models/github-pr-mirror-target.js", () => ({
  resolveGithubPrMirrorTarget: mocks.resolveTarget,
}))
vi.mock("../../models/github-pr-mirror.js", () => ({
  bindGithubPrMirror: mocks.bind,
  getGithubPrMirrorBinding: mocks.getBinding,
  patchGithubPrMirror: mocks.patch,
}))
vi.mock("../../models/repositories.js", () => ({
  listRepositoriesForGithubConnectionForOrg: mocks.listReposForOrg,
}))
vi.mock("../../models/github-installation.js", () => ({
  listGithubConnectionsForOrg: vi.fn(),
  listGithubConnections: mocks.listGithubConnections,
}))
vi.mock("../../domain/workspaces/capture-connector-mirror.js", () => ({
  captureConnectorMirrorTarget: mocks.capture,
}))
vi.mock(
  "../../services/github/pull-request-mirror/config-from-repo.js",
  () => ({
    loadGithubPrMirrorConfigFromRepo: mocks.loadConfig,
  }),
)
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflowWithWorkerWake,
}))

import { runWorkflowWithWorkerWake } from "../client.js"
import {
  enqueueGithubPrMirrorEnsureSweep,
  githubEnsurePrMirror,
} from "./github-ensure-pr-mirror.js"
import {
  enqueueGithubPrMirrorContent,
  githubSyncContent,
} from "./github-sync-content.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const CONFIG_SHA = "a".repeat(40)
const CHILD_SHA = "b".repeat(40)

const binding = {
  enabled: true,
  setupPhase: "draft",
  repositoryId: "repo_ctx",
  repositoryName: "acme/ctxpipe-context",
  githubConnectionId: "con_gh",
  connectionId: "con_gh",
  gitUrl: "https://github.com/acme/ctxpipe-context.git",
  branch: "main",
  lastContentCommitSha: null,
  lastContentLaunchToken: null,
  contentSyncGeneration: 0,
}

const captured = {
  workspaceId: "ws_1",
  contentSyncGeneration: 0,
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
  paths: [] as string[],
  config: undefined,
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function stubWritePlan() {
  mocks.resolveTarget.mockResolvedValue({
    repositoryId: "repo_ctx",
    repositoryName: "acme/ctxpipe-context",
    branch: "main",
  })
  mocks.bind.mockResolvedValue(binding)
  mocks.listReposForOrg.mockResolvedValue([
    { name: "acme/api" },
    { name: "acme/ctxpipe-context" },
  ])
  mocks.loadConfig.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue(captured)
}

function workflowStep(runWorkflow: (...args: never[]) => Promise<unknown>) {
  return {
    run: async (
      _options: { name: string },
      operation: () => Promise<unknown>,
    ) => operation(),
    runWorkflow,
  }
}

describe("githubEnsurePrMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubWritePlan()
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 1 })
    mocks.runWorkflowWithWorkerWake.mockResolvedValue({
      workflowRun: { id: "run_pending", status: "pending" },
    })
  })

  it("enqueues ensure once per GitHub connection across orgs", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
      { id: "con_b", orgId: "org_b" },
    ])
    const enqueued = await enqueueGithubPrMirrorEnsureSweep()
    expect(enqueued).toBe(2)
    expect(runWorkflowWithWorkerWake).toHaveBeenCalledTimes(2)
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      1,
      githubEnsurePrMirror.spec,
      { orgId: "org_a", connectionId: "con_a" },
      { idempotencyKey: "github-pr-mirror-startup:v1:org_a:con_a" },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubEnsurePrMirror.spec,
      { orgId: "org_b", connectionId: "con_b" },
      { idempotencyKey: "github-pr-mirror-startup:v1:org_b:con_b" },
    )
  })

  it("starts a retry when the keyed startup run already failed", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.runWorkflowWithWorkerWake
      .mockResolvedValueOnce({
        workflowRun: { id: "run_failed", status: "failed" },
      })
      .mockResolvedValueOnce({
        workflowRun: { id: "run_retry", status: "pending" },
      })

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubEnsurePrMirror.spec,
      { orgId: "org_a", connectionId: "con_a" },
      {
        idempotencyKey:
          "github-pr-mirror-startup:v1:org_a:con_a:retry:run_failed",
      },
    )
  })

  it("starts a distinct content run when a completed ensure left sync_failed", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: "sha_config",
    })
    mocks.runWorkflowWithWorkerWake
      .mockResolvedValueOnce({
        workflowRun: { id: "run_ensure", status: "completed" },
      })
      .mockResolvedValueOnce({
        workflowRun: { id: "run_content_failed", status: "failed" },
      })
      .mockResolvedValueOnce({
        workflowRun: { id: "run_content_retry", status: "pending" },
      })

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      1,
      githubEnsurePrMirror.spec,
      { orgId: "org_a", connectionId: "con_a" },
      { idempotencyKey: "github-pr-mirror-startup:v1:org_a:con_a" },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      { idempotencyKey: "github-pr-mirror-content:con_a:sha_config" },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      3,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_a:sha_config:retry:run_content_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenCalledTimes(3)
  })

  it("coalesces a pending content retry across startup storms", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: "sha_config",
    })
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (_spec, _input, options?: { idempotencyKey?: string }) => {
        if (options?.idempotencyKey?.includes(":retry:run_content_failed")) {
          return {
            workflowRun: { id: "run_content_retry", status: "pending" },
          }
        }
        if (options?.idempotencyKey?.startsWith("github-pr-mirror-content:")) {
          return {
            workflowRun: { id: "run_content_failed", status: "failed" },
          }
        }
        return { workflowRun: { id: "run_ensure", status: "completed" } }
      },
    )

    await enqueueGithubPrMirrorEnsureSweep()
    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenCalledTimes(6)
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      3,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_a:sha_config:retry:run_content_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      6,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_a:sha_config:retry:run_content_failed",
      },
    )
  })

  it("retries the later webhook SHA after a completed ensure, not the earlier completed content SHA", async () => {
    const mirror = {
      ...binding,
      setupPhase: "sync_failed" as const,
      lastContentCommitSha: "sha_a" as string | null,
      lastContentLaunchToken: null as string | null,
    }
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockImplementation(async () => mirror)
    mocks.patch.mockImplementation(
      async (input: {
        reserveContentLaunch?: boolean
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
          setupPhase?: string
        }
      }) => {
        if (input.patch.lastContentCommitSha !== undefined) {
          mirror.lastContentCommitSha = input.patch.lastContentCommitSha
        }
        if (input.patch.lastContentLaunchToken !== undefined) {
          mirror.lastContentLaunchToken = input.patch.lastContentLaunchToken
        }
        if (input.patch.setupPhase) {
          mirror.setupPhase = input.patch.setupPhase as typeof mirror.setupPhase
        }
        return { applied: true, contentSyncGeneration: 1 }
      },
    )
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (_spec, _input, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey ?? ""
        if (key.startsWith("github-pr-mirror-startup:")) {
          return { workflowRun: { id: "run_ensure", status: "completed" } }
        }
        if (key === "github-pr-mirror-content:con_a:sha_a") {
          return { workflowRun: { id: "run_a_completed", status: "completed" } }
        }
        if (key === "github-pr-mirror-content:con_a:sha_b") {
          return { workflowRun: { id: "run_b_failed", status: "failed" } }
        }
        if (key === "github-pr-mirror-content:con_a:sha_b:retry:run_b_failed") {
          return { workflowRun: { id: "run_b_retry", status: "pending" } }
        }
        return { workflowRun: { id: "run_other", status: "pending" } }
      },
    )

    await enqueueGithubPrMirrorContent({
      orgId: "org_a",
      connectionId: "con_a",
      commitSha: "sha_b",
    })
    expect(mirror.lastContentCommitSha).toBe("sha_b")
    expect(runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_a:sha_b:retry:run_b_failed",
      },
    )

    await enqueueGithubPrMirrorEnsureSweep()

    const contentKeys = mocks.runWorkflowWithWorkerWake.mock.calls
      .filter((call) => call[0] === githubSyncContent.spec)
      .map((call) => (call[2] as { idempotencyKey: string }).idempotencyKey)
    expect(contentKeys).toEqual([
      "github-pr-mirror-content:con_a:sha_b",
      "github-pr-mirror-content:con_a:sha_b:retry:run_b_failed",
      "github-pr-mirror-content:con_a:sha_b",
      "github-pr-mirror-content:con_a:sha_b:retry:run_b_failed",
    ])
    expect(contentKeys).not.toContain("github-pr-mirror-content:con_a:sha_a")
  })

  it("retries a failed manual launch token instead of the completed SHA marker", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: "sha_a",
      lastContentLaunchToken: "tok_retry",
    })
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (_spec, _input, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey ?? ""
        if (key.startsWith("github-pr-mirror-startup:")) {
          return { workflowRun: { id: "run_ensure", status: "completed" } }
        }
        if (key === "github-pr-mirror-content:con_a:sha_a") {
          return { workflowRun: { id: "run_a_completed", status: "completed" } }
        }
        if (key === "github-pr-mirror-content:con_a:sha_a:launch:tok_retry") {
          return { workflowRun: { id: "run_manual_failed", status: "failed" } }
        }
        if (
          key ===
          "github-pr-mirror-content:con_a:sha_a:launch:tok_retry:retry:run_manual_failed"
        ) {
          return { workflowRun: { id: "run_manual_retry", status: "pending" } }
        }
        return { workflowRun: { id: "run_other", status: "pending" } }
      },
    )

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey: "github-pr-mirror-content:con_a:sha_a:launch:tok_retry",
      },
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      3,
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_a:sha_a:launch:tok_retry:retry:run_manual_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).not.toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_a", connectionId: "con_a" }),
      { idempotencyKey: "github-pr-mirror-content:con_a:sha_a" },
    )
  })

  it("does not retry a completed later launch when a stalled earlier helper starts last", async () => {
    const store = {
      generation: 0,
      sha: null as string | null,
      token: null as string | null,
      phase: "draft" as string,
    }
    const aAfterReserve = deferred()
    let reservedA = false
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      setupPhase: store.phase,
      lastContentCommitSha: store.sha,
      lastContentLaunchToken: store.token,
      contentSyncGeneration: store.generation,
    }))
    mocks.patch.mockImplementation(
      async (input: {
        reserveContentLaunch?: boolean
        claimContentRun?: boolean
        expectedContentSyncGeneration?: number
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
          return { applied: true, contentSyncGeneration: generation }
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
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (spec, _input, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey ?? ""
        if (spec === githubEnsurePrMirror.spec) {
          return { workflowRun: { id: "run_ensure", status: "completed" } }
        }
        if (key.endsWith(":sha_a")) {
          return { workflowRun: { id: "run_a", status: "pending" } }
        }
        if (key.endsWith(":sha_b")) {
          return { workflowRun: { id: "run_b", status: "completed" } }
        }
        return { workflowRun: { id: "run_other", status: "pending" } }
      },
    )

    const aEnqueue = enqueueGithubPrMirrorContent({
      orgId: "org_a",
      connectionId: "con_a",
      commitSha: "sha_a",
    })
    await vi.waitFor(() => {
      expect(store).toMatchObject({ generation: 1, sha: "sha_a" })
    })
    await enqueueGithubPrMirrorContent({
      orgId: "org_a",
      connectionId: "con_a",
      commitSha: "sha_b",
    })
    store.phase = "live"
    aAfterReserve.resolve()
    await aEnqueue

    await enqueueGithubPrMirrorEnsureSweep()

    const contentKeys = mocks.runWorkflowWithWorkerWake.mock.calls
      .filter((call) => call[0] === githubSyncContent.spec)
      .map((call) => (call[2] as { idempotencyKey: string }).idempotencyKey)
    expect(contentKeys).toEqual([
      "github-pr-mirror-content:con_a:sha_b",
      "github-pr-mirror-content:con_a:sha_a",
    ])
    expect(store).toMatchObject({
      generation: 2,
      sha: "sha_b",
      phase: "live",
    })
  })

  it("retries ensure when a completed startup run is sync_failed without a content marker", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: null,
      lastContentLaunchToken: null,
    })
    mocks.runWorkflowWithWorkerWake
      .mockResolvedValueOnce({
        workflowRun: { id: "run_ensure", status: "completed" },
      })
      .mockResolvedValueOnce({
        workflowRun: { id: "run_ensure_retry", status: "pending" },
      })

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubEnsurePrMirror.spec,
      { orgId: "org_a", connectionId: "con_a" },
      {
        idempotencyKey:
          "github-pr-mirror-startup:v1:org_a:con_a:retry:sync_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).not.toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.anything(),
      expect.anything(),
    )
  })

  it("does not enqueue content when a completed ensure is already live", async () => {
    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_a", orgId: "org_a" },
    ])
    mocks.getBinding.mockResolvedValue({
      ...binding,
      setupPhase: "live",
      lastContentCommitSha: "sha_config",
    })
    mocks.runWorkflowWithWorkerWake.mockResolvedValue({
      workflowRun: { id: "run_ensure", status: "completed" },
    })

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenCalledTimes(1)
    expect(runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubEnsurePrMirror.spec,
      { orgId: "org_a", connectionId: "con_a" },
      { idempotencyKey: "github-pr-mirror-startup:v1:org_a:con_a" },
    )
  })
})

describe("githubEnsurePrMirror child control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubWritePlan()
    mocks.patch.mockResolvedValue({ applied: true, contentSyncGeneration: 1 })
    mocks.runWorkflowWithWorkerWake.mockResolvedValue({
      workflowRun: { id: "run_content", status: "pending" },
    })
  })

  it("runs the config mirror as a child and enqueues content only after it finishes", async () => {
    const childStarted = deferred()
    const releaseChild = deferred()
    const events: string[] = []
    const finished = githubEnsurePrMirror.fn({
      step: workflowStep(async (spec, input, options) => {
        expect(spec).toBe(workspaceConnectorMirror.spec)
        expect(options).toEqual({ name: "commit-github-pr-config" })
        expect(input).toMatchObject({
          orgId: "org_1",
          workspaceId: "ws_1",
          revision: captured.revision,
          mirror: captured.mirror,
          files: [expect.objectContaining({ path: "github/config.yaml" })],
          deletePaths: [],
        })
        events.push("config-child-start")
        childStarted.resolve()
        await releaseChild.promise
        events.push("config-child-done")
        return { committed: true as const, commitSha: CHILD_SHA }
      }),
      input: { orgId: "org_1", connectionId: "con_gh" },
      run: { id: "run_1" },
      version: null,
    } as never)

    await childStarted.promise
    expect(events).toEqual(["config-child-start"])
    expect(mocks.runWorkflowWithWorkerWake).not.toHaveBeenCalled()

    releaseChild.resolve()
    await expect(finished).resolves.toEqual({ status: "started" })
    expect(events).toEqual(["config-child-start", "config-child-done"])
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenCalledTimes(1)
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_1", connectionId: "con_gh" }),
      {
        idempotencyKey: `github-pr-mirror-content:con_gh:${CHILD_SHA}`,
      },
    )
  })

  it("retries a failed manual SHA/token from ordinary ensure without dropping the token", async () => {
    const store = {
      generation: 2,
      sha: "sha_a" as string | null,
      token: "tok_manual" as string | null,
      phase: "sync_failed" as string,
    }
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: "sha_a",
      lastContentLaunchToken: "tok_manual",
      contentSyncGeneration: 2,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    mocks.patch.mockImplementation(
      async (input: {
        reserveContentLaunch?: boolean
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
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
          return { applied: true, contentSyncGeneration: store.generation }
        }
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )
    mocks.runWorkflowWithWorkerWake.mockImplementation(
      async (_spec, _input, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey ?? ""
        if (key === "github-pr-mirror-content:con_gh:sha_a") {
          return {
            workflowRun: { id: "run_base_completed", status: "completed" },
          }
        }
        if (key === "github-pr-mirror-content:con_gh:sha_a:launch:tok_manual") {
          return {
            workflowRun: { id: "run_manual_failed", status: "failed" },
          }
        }
        if (
          key ===
          "github-pr-mirror-content:con_gh:sha_a:launch:tok_manual:retry:run_manual_failed"
        ) {
          return {
            workflowRun: { id: "run_manual_retry", status: "pending" },
          }
        }
        return { workflowRun: { id: "run_other", status: "pending" } }
      },
    )

    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(vi.fn()),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).resolves.toEqual({ status: "started" })

    expect(runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({
        orgId: "org_1",
        connectionId: "con_gh",
        commitSha: "sha_a",
        launchToken: "tok_manual",
      }),
      {
        idempotencyKey:
          "github-pr-mirror-content:con_gh:sha_a:launch:tok_manual:retry:run_manual_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).not.toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.anything(),
      { idempotencyKey: "github-pr-mirror-content:con_gh:sha_a" },
    )
    expect(store).toMatchObject({
      generation: 2,
      sha: "sha_a",
      token: "tok_manual",
      phase: "sync_failed",
    })
  })

  it("enqueues content without rewriting a matching failed config", async () => {
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "sync_failed",
      lastContentCommitSha: CHILD_SHA,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    const runWorkflow = vi.fn()
    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(runWorkflow),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).resolves.toEqual({ status: "started" })
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({ claimEnsureStage: true }),
    )
    expect(mocks.runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.objectContaining({ orgId: "org_1", connectionId: "con_gh" }),
      { idempotencyKey: `github-pr-mirror-content:con_gh:${CHILD_SHA}` },
    )
  })

  it("does not start a config child when the picker yaml is already live", async () => {
    mocks.bind.mockResolvedValue({ ...binding, setupPhase: "live" })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/api"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    const runWorkflow = vi.fn()
    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(runWorkflow),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).resolves.toEqual({ status: "unchanged" })
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(mocks.runWorkflowWithWorkerWake).not.toHaveBeenCalled()
  })

  it("does not mark sync_failed when planning the config write fails before the ensure claim", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("GitHub unavailable"))
    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(vi.fn()),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).rejects.toThrow("GitHub unavailable")
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(mocks.runWorkflowWithWorkerWake).not.toHaveBeenCalled()
  })

  it("claims the ensure stage before the config child and retries ensure after a live config rewrite fails", async () => {
    const store = {
      generation: 1,
      sha: "sha_a" as string | null,
      token: null as string | null,
      phase: "live" as string,
    }
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "live",
      lastContentCommitSha: "sha_a",
      lastContentLaunchToken: null,
      contentSyncGeneration: 1,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/web"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    mocks.patch.mockImplementation(
      async (input: {
        claimEnsureStage?: boolean
        expectedContentSyncGeneration?: number
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
          setupPhase?: string
        }
      }) => {
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimEnsureStage) {
          const sameIdentity = store.sha === null && store.token === null
          if (!sameIdentity) store.generation += 1
          store.sha = input.patch.lastContentCommitSha ?? null
          store.token = input.patch.lastContentLaunchToken ?? null
          return { applied: true, contentSyncGeneration: store.generation }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(async () => {
          throw new Error("config child failed")
        }),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).rejects.toThrow("config child failed")

    expect(store).toMatchObject({
      generation: 2,
      sha: null,
      token: null,
      phase: "sync_failed",
    })
    expect(mocks.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        claimEnsureStage: true,
        expectedContentSyncGeneration: 1,
        patch: {
          lastContentCommitSha: null,
          lastContentLaunchToken: null,
        },
      }),
    )
    expect(mocks.patch).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_gh",
      expectedContentSyncGeneration: 2,
      patch: { setupPhase: "sync_failed" },
    })
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          setupPhase: "sync_failed",
          lastContentCommitSha: null,
        }),
      }),
    )

    mocks.listGithubConnections.mockResolvedValue([
      { id: "con_gh", orgId: "org_1" },
    ])
    mocks.getBinding.mockImplementation(async () => ({
      ...binding,
      setupPhase: store.phase,
      lastContentCommitSha: store.sha,
      lastContentLaunchToken: store.token,
      contentSyncGeneration: store.generation,
    }))
    mocks.runWorkflowWithWorkerWake
      .mockResolvedValueOnce({
        workflowRun: { id: "run_ensure", status: "completed" },
      })
      .mockResolvedValueOnce({
        workflowRun: { id: "run_ensure_retry", status: "pending" },
      })

    await enqueueGithubPrMirrorEnsureSweep()

    expect(runWorkflowWithWorkerWake).toHaveBeenCalledWith(
      githubEnsurePrMirror.spec,
      { orgId: "org_1", connectionId: "con_gh" },
      {
        idempotencyKey:
          "github-pr-mirror-startup:v1:org_1:con_gh:retry:sync_failed",
      },
    )
    expect(runWorkflowWithWorkerWake).not.toHaveBeenCalledWith(
      githubSyncContent.spec,
      expect.anything(),
      expect.anything(),
    )
  })

  it("does not let a stale ensure failure clear a newer content launch marker", async () => {
    const store = {
      generation: 1,
      sha: "sha_a" as string | null,
      token: null as string | null,
      phase: "live" as string,
    }
    const afterClaim = deferred()
    const releaseChild = deferred()
    mocks.bind.mockResolvedValue({
      ...binding,
      setupPhase: "live",
      lastContentCommitSha: "sha_a",
      lastContentLaunchToken: null,
      contentSyncGeneration: 1,
    })
    mocks.loadConfig.mockResolvedValue({
      repositories: ["acme/web"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 200,
    })
    mocks.patch.mockImplementation(
      async (input: {
        claimEnsureStage?: boolean
        reserveContentLaunch?: boolean
        expectedContentSyncGeneration?: number
        patch: {
          lastContentCommitSha?: string | null
          lastContentLaunchToken?: string | null
          setupPhase?: string
        }
      }) => {
        if (
          input.expectedContentSyncGeneration != null &&
          input.expectedContentSyncGeneration !== store.generation
        ) {
          return { applied: false, contentSyncGeneration: store.generation }
        }
        if (input.claimEnsureStage) {
          const sameIdentity = store.sha === null && store.token === null
          if (!sameIdentity) store.generation += 1
          store.sha = input.patch.lastContentCommitSha ?? null
          store.token = input.patch.lastContentLaunchToken ?? null
          afterClaim.resolve()
          return { applied: true, contentSyncGeneration: store.generation }
        }
        if (input.reserveContentLaunch) {
          const sameIdentity =
            store.sha === (input.patch.lastContentCommitSha ?? null) &&
            store.token === (input.patch.lastContentLaunchToken ?? null)
          if (!sameIdentity) {
            store.generation += 1
            store.sha = input.patch.lastContentCommitSha ?? null
            store.token = input.patch.lastContentLaunchToken ?? null
          }
          return { applied: true, contentSyncGeneration: store.generation }
        }
        if (input.patch.setupPhase) store.phase = input.patch.setupPhase
        if (input.patch.lastContentCommitSha !== undefined) {
          store.sha = input.patch.lastContentCommitSha
        }
        if (input.patch.lastContentLaunchToken !== undefined) {
          store.token = input.patch.lastContentLaunchToken
        }
        return { applied: true, contentSyncGeneration: store.generation }
      },
    )

    const finished = githubEnsurePrMirror.fn({
      step: {
        run: async (
          _options: { name: string },
          operation: () => Promise<unknown>,
        ) => operation(),
        runWorkflow: async () => {
          await releaseChild.promise
          throw new Error("config child failed")
        },
      },
      input: { orgId: "org_1", connectionId: "con_gh" },
      run: { id: "run_1" },
      version: null,
    } as never)

    await afterClaim.promise
    await enqueueGithubPrMirrorContent({
      orgId: "org_1",
      connectionId: "con_gh",
      commitSha: "sha_b",
    })
    expect(store).toMatchObject({ generation: 3, sha: "sha_b" })

    releaseChild.resolve()
    await expect(finished).rejects.toThrow("config child failed")
    expect(store).toMatchObject({
      generation: 3,
      sha: "sha_b",
      token: null,
      phase: "live",
    })
  })

  it("does not treat a parked config child as a failed ensure", async () => {
    const sleep = new Error("park")
    sleep.name = "SleepSignal"
    await expect(
      githubEnsurePrMirror.fn({
        step: workflowStep(async () => {
          throw sleep
        }),
        input: { orgId: "org_1", connectionId: "con_gh" },
        run: { id: "run_1" },
        version: null,
      } as never),
    ).rejects.toMatchObject({ name: "SleepSignal" })
    expect(mocks.patch).toHaveBeenCalledWith(
      expect.objectContaining({ claimEnsureStage: true }),
    )
    expect(mocks.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ setupPhase: "sync_failed" }),
      }),
    )
    expect(mocks.runWorkflowWithWorkerWake).not.toHaveBeenCalled()
  })
})
