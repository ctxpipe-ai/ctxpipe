import { afterEach, describe, expect, it, vi } from "vitest"

const patchMock = vi.hoisted(() => vi.fn())
const getStatusMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({
  client: {
    ":orgSlug": {
      api: {
        v1: {
          connectors: {
            slack: {
              status: { $get: getStatusMock },
              config: { $patch: patchMock },
            },
          },
        },
      },
    },
  },
}))

import {
  fetchSlackConnectorStatus,
  patchSlackConnectorConfig,
  SlackConnectionNotFoundError,
} from "./slack-connector"

describe("fetchSlackConnectorStatus", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns the draft/live status shape from the backend", async () => {
    getStatusMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          isInstalled: true,
          installationStatus: "installed",
          teamName: "Acme",
          isGithubLinked: true,
          setupPhase: "live",
          syncTarget: {
            repositoryId: "repo_1",
            repositoryName: "acme/context",
            branch: "main",
            githubConnectionId: "ghc_1",
          },
        }),
        { status: 200 },
      ),
    )

    await expect(
      fetchSlackConnectorStatus("acme", "con_1"),
    ).resolves.toMatchObject({
      isInstalled: true,
      setupPhase: "live",
      syncTarget: { repositoryId: "repo_1" },
    })
  })

  it("surfaces an error when the status request fails", async () => {
    getStatusMock.mockResolvedValue(new Response(null, { status: 500 }))

    await expect(fetchSlackConnectorStatus("acme", "con_1")).rejects.toThrow(
      "Failed to fetch Slack connector status",
    )
  })

  it("throws SlackConnectionNotFoundError on 404", async () => {
    getStatusMock.mockResolvedValue(new Response(null, { status: 404 }))

    await expect(
      fetchSlackConnectorStatus("acme", "con_missing"),
    ).rejects.toThrow(SlackConnectionNotFoundError)
  })
})

describe("patchSlackConnectorConfig", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("binds a repository and returns the resulting setup phase", async () => {
    patchMock.mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, setupPhase: "live" }), {
        status: 200,
      }),
    )

    await expect(
      patchSlackConnectorConfig("acme", { repositoryId: "repo_1" }, "con_1"),
    ).resolves.toEqual({ accepted: true, setupPhase: "live" })
    expect(patchMock).toHaveBeenCalledWith({
      param: { orgSlug: "acme" },
      query: { connectionId: "con_1" },
      json: { repositoryId: "repo_1" },
    })
  })

  it("can bind by GitHub repository metadata without a registered repositoryId", async () => {
    patchMock.mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, setupPhase: "live" }), {
        status: 200,
      }),
    )

    await expect(
      patchSlackConnectorConfig(
        "acme",
        {
          repositoryName: "acme/ctxpipe-context",
          gitUrl: "https://github.com/acme/ctxpipe-context.git",
          githubConnectionId: "ghc_1",
          branch: "main",
        },
        "con_1",
      ),
    ).resolves.toEqual({ accepted: true, setupPhase: "live" })
  })

  it("surfaces the backend error message on failure", async () => {
    patchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Repository not found for organization" }),
        { status: 404 },
      ),
    )

    await expect(
      patchSlackConnectorConfig("acme", { repositoryId: "repo_missing" }),
    ).rejects.toThrow("Repository not found for organization")
  })
})
