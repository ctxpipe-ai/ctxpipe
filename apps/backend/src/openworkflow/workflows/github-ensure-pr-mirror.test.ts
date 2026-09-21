import { beforeEach, describe, expect, it, vi } from "vitest"

const ensureMock = vi.hoisted(() => vi.fn())

vi.mock("../../config/env.js", () => ({
  parseEnv: vi.fn(() => ({})),
}))
vi.mock("../../services/github/pull-request-mirror/ensure.js", () => ({
  ensureGithubPrMirror: ensureMock,
}))
const listGithubConnections = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  listGithubConnectionsForOrg: vi.fn(),
  listGithubConnections,
}))
vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({ error: vi.fn() }),
  log: { error: vi.fn() },
}))
vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: vi.fn(),
}))

import { runWorkflowWithWorkerWake } from "../client.js"
import {
  enqueueGithubPrMirrorEnsureSweep,
  githubEnsurePrMirror,
} from "./github-ensure-pr-mirror.js"

describe("githubEnsurePrMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureMock.mockResolvedValue({ status: "started" })
  })

  it("ensures capture for the GitHub connection", async () => {
    await githubEnsurePrMirror.fn({
      input: { orgId: "org_1", connectionId: "con_gh" },
    } as never)
    expect(ensureMock).toHaveBeenCalledWith({
      orgId: "org_1",
      connectionId: "con_gh",
      env: {},
      repositoryId: undefined,
      branch: undefined,
    })
  })

  it("enqueues ensure once per GitHub connection across orgs", async () => {
    listGithubConnections.mockResolvedValue([
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
    )
    expect(runWorkflowWithWorkerWake).toHaveBeenNthCalledWith(
      2,
      githubEnsurePrMirror.spec,
      { orgId: "org_b", connectionId: "con_b" },
    )
  })
})
