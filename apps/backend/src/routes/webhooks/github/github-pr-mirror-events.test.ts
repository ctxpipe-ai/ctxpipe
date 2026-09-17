import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listInstallations: vi.fn(),
  findRepo: vi.fn(),
  getBinding: vi.fn(),
  runWorkflow: vi.fn(),
}))

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: vi.fn((_orgId: string, fn: () => unknown) => fn()),
}))
vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: mocks.listInstallations,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: mocks.findRepo,
}))
vi.mock("../../../models/github-pr-mirror.js", () => ({
  getGithubPrMirrorBinding: mocks.getBinding,
}))
vi.mock("../../../openworkflow/client.js", () => ({
  runWorkflowWithWorkerWake: mocks.runWorkflow,
}))
vi.mock("../../../openworkflow/workflows/github-sync-pull-request.js", () => ({
  githubSyncPullRequest: { spec: { name: "github-sync-pull-request" } },
}))

import {
  candidateFromPullRequestPayload,
  githubPrMirrorIdempotencyKey,
  maybeEnqueueGithubPrMirror,
} from "./github-pr-mirror-events.js"

describe("maybeEnqueueGithubPrMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listInstallations.mockResolvedValue([
      { id: "con_gh", orgId: "org_1" },
    ])
    mocks.findRepo.mockResolvedValue({ id: "repo_api" })
    mocks.getBinding.mockResolvedValue({
      enabled: true,
      setupPhase: "live",
    })
    mocks.runWorkflow.mockResolvedValue({ workflowRun: { id: "wr_1" } })
  })

  it("enqueues a pull-request mirror job with webhook facts and an idempotency key", async () => {
    await maybeEnqueueGithubPrMirror({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: {
          number: 42,
          merged: true,
          draft: false,
          state: "closed",
          updated_at: "2026-03-02T11:00:00Z",
        },
        repository: { full_name: "acme/api" },
        installation: { id: 99 },
      },
      githubConnectionId: "con_gh",
      log: { error: vi.fn() },
    })

    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "github-sync-pull-request" },
      {
        orgId: "org_1",
        connectionId: "con_gh",
        sourceRepository: "acme/api",
        number: 42,
        candidate: {
          merged: true,
          draft: false,
          updatedAt: "2026-03-02T11:00:00Z",
        },
      },
      { idempotencyKey: "github-pr:con_gh:acme/api:42:2026-03-02T11:00:00Z" },
    )
  })

  it("passes no candidate for issue comments and keys on the comment timestamp", async () => {
    await maybeEnqueueGithubPrMirror({
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: { url: "x" } },
        comment: { created_at: "2026-03-03T00:00:00Z" },
        repository: { full_name: "acme/api" },
        installation: { id: 99 },
      },
      githubConnectionId: "con_gh",
      log: { error: vi.fn() },
    })
    expect(mocks.runWorkflow).toHaveBeenCalledWith(
      { name: "github-sync-pull-request" },
      {
        orgId: "org_1",
        connectionId: "con_gh",
        sourceRepository: "acme/api",
        number: 7,
      },
      { idempotencyKey: "github-pr:con_gh:acme/api:7:2026-03-03T00:00:00Z" },
    )
  })

  it("derives candidates from payload facts", () => {
    expect(
      candidateFromPullRequestPayload({
        number: 1,
        merged_at: "2026-03-02T11:00:00Z",
        draft: false,
        updated_at: "2026-03-02T11:00:00Z",
      }),
    ).toEqual({ merged: true, draft: false, updatedAt: "2026-03-02T11:00:00Z" })
    expect(
      candidateFromPullRequestPayload({ number: 1, updated_at: "t" }),
    ).toBeUndefined()
    expect(candidateFromPullRequestPayload(undefined)).toBeUndefined()
    expect(
      githubPrMirrorIdempotencyKey({
        connectionId: "c",
        sourceRepository: "a/b",
        number: 3,
        version: undefined,
      }),
    ).toBe("github-pr:c:a/b:3:unknown")
  })

  it("skips pull requests for repositories that are not ingested", async () => {
    mocks.findRepo.mockResolvedValue(null)
    await maybeEnqueueGithubPrMirror({
      eventName: "pull_request",
      payload: {
        action: "closed",
        pull_request: { number: 42, merged: true },
        repository: { full_name: "acme/other" },
        installation: { id: 99 },
      },
      log: { error: vi.fn() },
    })
    expect(mocks.runWorkflow).not.toHaveBeenCalled()
  })
})
