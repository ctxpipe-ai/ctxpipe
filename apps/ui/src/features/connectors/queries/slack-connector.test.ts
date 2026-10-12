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
