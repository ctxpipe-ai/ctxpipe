import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import {
  capSlackThreadMessages,
  exchangeSlackOAuthCode,
  fetchSlackFileInfo,
  getSlackOAuthAuthorizeUrl,
  type SlackOAuthMissingScopesError,
  verifySlackInstallation,
} from "./client.js"
import { SLACK_BOT_SCOPES } from "./scopes.js"

const env = {
  AUTH_BASE_URL: "https://ctxpipe.example",
  SLACK_CLIENT_ID: "slack-client",
  SLACK_CLIENT_SECRET: "slack-secret",
} as Env

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Slack OAuth client", () => {
  it("requests every required bot scope, including app mentions", () => {
    const url = new URL(
      getSlackOAuthAuthorizeUrl({ env, state: "signed-state" }),
    )

    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    )
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "app_mentions:read",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "chat:write",
      "files:read",
      "users:read",
    ])
    expect(url.searchParams.get("state")).toBe("signed-state")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ctxpipe.example/api/v1/connectors/slack/oauth/callback",
    )
  })

  it("rejects a token missing a required bot scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-test",
            scope: SLACK_BOT_SCOPES.filter(
              (scope) => scope !== "app_mentions:read",
            ).join(","),
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(
      exchangeSlackOAuthCode({ env, code: "oauth-code" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SlackOAuthMissingScopesError>>({
        name: "SlackOAuthMissingScopesError",
        missingScopes: ["app_mentions:read"],
      }),
    )
  })

  it("accepts additive scopes returned in any order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-test",
            scope: ["reactions:read", ...SLACK_BOT_SCOPES].reverse().join(","),
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(
      exchangeSlackOAuthCode({ env, code: "oauth-code" }),
    ).resolves.toMatchObject({ access_token: "xoxb-test" })
  })

  it("verifies an installed bot identity and its live token scopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_TRU",
            user_id: "U_BOT",
            bot_id: "B_BOT",
          }),
          {
            status: 200,
            headers: {
              "x-oauth-scopes": "chat:write,app_mentions:read,channels:history",
            },
          },
        ),
      ),
    )

    await expect(
      verifySlackInstallation({
        connection: {
          id: "con_tru",
          orgId: "org_tru",
          botTokenEnc: "unused",
          teamId: "T_TRU",
          teamName: "Tru Rec",
          botUserId: "U_BOT",
          botHandle: "ctxpipe",
          appId: "A_CTXPIPE",
          ownerUserId: "user_1",
          status: "installed",
          lastEventPayload: null,
          repositoryId: "repo_1",
          branch: "main",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        botToken: "xoxb-test",
      }),
    ).resolves.toEqual({
      appId: "A_CTXPIPE",
      storedTeamId: "T_TRU",
      storedBotUserId: "U_BOT",
      reportedTeamId: "T_TRU",
      reportedBotUserId: "U_BOT",
      botId: "B_BOT",
      grantedScopes: ["app_mentions:read", "channels:history", "chat:write"],
      missingScopes: [
        "channels:read",
        "groups:history",
        "groups:read",
        "files:read",
        "users:read",
      ],
      identityMatches: true,
    })
  })
})

describe("capSlackThreadMessages", () => {
  it("keeps short threads intact", () => {
    expect(capSlackThreadMessages(["a", "b"], false, 500)).toEqual({
      messages: ["a", "b"],
      truncated: false,
    })
  })

  it("truncates when over the cap", () => {
    expect(capSlackThreadMessages(["a", "b", "c"], false, 2)).toEqual({
      messages: ["a", "b"],
      truncated: true,
    })
  })

  it("marks truncated when the cap is exact but more pages remain", () => {
    expect(capSlackThreadMessages(["a", "b"], true, 2)).toEqual({
      messages: ["a", "b"],
      truncated: true,
    })
  })
})

describe("fetchSlackFileInfo", () => {
  it("retries non-JSON Slack server errors", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("upstream unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response("<html>bad gateway</html>", { status: 502 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            file: { id: "F1", name: "diagram.png" },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    const result = fetchSlackFileInfo({
      botToken: "xoxb-test",
      fileId: "F1",
    })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual({ id: "F1", name: "diagram.png" })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("does not wait or retry past an aborted asset deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const controller = new AbortController()
    controller.abort(new Error("asset deadline"))

    await expect(
      fetchSlackFileInfo({
        botToken: "xoxb-test",
        fileId: "F1",
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
