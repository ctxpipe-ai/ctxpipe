import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findRepository: vi.fn(),
  withOrgDbContext: vi.fn((_orgId: string, handler: () => Promise<unknown>) =>
    handler(),
  ),
}))

vi.mock("../../../db/client.js", () => ({
  withOrgDbContext: mocks.withOrgDbContext,
}))
vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: mocks.findRepository,
}))

import { resolveSourceRepositoryId } from "./repositoryResolution.js"

describe("resolveSourceRepositoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findRepository.mockResolvedValue({ id: "repo_source" })
  })

  it("resolves the source repository inside the organisation DB context", async () => {
    await expect(
      resolveSourceRepositoryId({
        orgId: "org_1",
        repository: "acme/api",
        githubConnectionId: "con_github",
      }),
    ).resolves.toBe("repo_source")

    expect(mocks.withOrgDbContext).toHaveBeenCalledWith(
      "org_1",
      expect.any(Function),
    )
    expect(mocks.findRepository).toHaveBeenCalledWith(
      "org_1",
      "acme/api",
      "con_github",
    )
  })

  it("returns and caches undefined when the repository is not connected", async () => {
    const cache = new Map<string, string | undefined>()
    mocks.findRepository.mockResolvedValueOnce(undefined)

    await expect(
      resolveSourceRepositoryId({
        orgId: "org_1",
        repository: "acme/unconnected",
        githubConnectionId: "con_github",
        cache,
      }),
    ).resolves.toBeUndefined()

    expect(cache.has("acme/unconnected")).toBe(true)
    expect(cache.get("acme/unconnected")).toBeUndefined()
  })

  it("propagates lookup failures instead of caching an unresolved identity", async () => {
    const cache = new Map<string, string | undefined>()
    mocks.findRepository.mockRejectedValueOnce(
      new Error("database unavailable"),
    )

    await expect(
      resolveSourceRepositoryId({
        orgId: "org_1",
        repository: "acme/api",
        githubConnectionId: "con_github",
        cache,
      }),
    ).rejects.toThrow("database unavailable")

    expect(cache.has("acme/api")).toBe(false)
  })
})
