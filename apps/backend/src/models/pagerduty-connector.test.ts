import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import {
  pagerdutyOAuthAppMetadata,
  planPagerdutySyncBindingUpdate,
} from "./pagerduty-connector.js"

const env = {
  AUTH_SECRET: "test-secret-at-least-32-characters-long-xx",
  PAGERDUTY_CLIENT_ID: "hosted-client",
  PAGERDUTY_CLIENT_SECRET: "hosted-secret",
} as unknown as Env

describe("planPagerdutySyncBindingUpdate", () => {
  it("resets lifecycle when the repository or branch changes", () => {
    expect(
      planPagerdutySyncBindingUpdate({
        existing: {
          id: "con_pagerduty",
          orgId: "org_1",
          connectionId: "con_pagerduty",
          repositoryId: "repo_1",
          branch: "main",
          enabled: true,
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        repositoryId: "repo_2",
        branch: "main",
        enabled: true,
      }),
    ).toEqual({
      changed: true,
      repositoryOrBranchChanged: true,
      resetLifecycle: true,
    })
  })
})

describe("PagerDuty OAuth app metadata", () => {
  it("reports an explicit redirect URI override to the setup wizard", () => {
    expect(
      pagerdutyOAuthAppMetadata(undefined, {
        ...env,
        AUTH_BASE_URL: "https://app.example.com",
        PAGERDUTY_REDIRECT_URI:
          "https://oauth.example.com/api/v1/integrations/pagerduty/callback",
      } as Env).oauthCallbackUrl,
    ).toBe("https://oauth.example.com/api/v1/integrations/pagerduty/callback")
  })
})
