import { describe, expect, it } from "vitest"
import {
  getOAuthConsentOrganizationId,
  getOAuthRequestClientId,
  OAUTH_GRANT_CLAIM,
  OAUTH_ORGANIZATION_CLAIM,
  oauthAccessTokenClaims,
  readOAuthRequestClientId,
  resolveOAuthConsentReferenceId,
  selectOAuthOrganizationBinding,
  withOAuthRequestContext,
} from "./oauth-organization.js"

describe("selectOAuthOrganizationBinding", () => {
  it("binds a single membership without another selection screen", () => {
    expect(selectOAuthOrganizationBinding(["org_acme"], undefined)).toEqual({
      requiresSelection: false,
      referenceId: "org_acme",
    })
  })

  it("binds the active membership and does not re-open selection", () => {
    expect(
      selectOAuthOrganizationBinding(
        ["org_acme", "org_consulting"],
        "org_consulting",
      ),
    ).toEqual({
      requiresSelection: false,
      referenceId: "org_consulting",
    })
  })

  it("requires selection when no valid organization can be resolved", () => {
    expect(
      selectOAuthOrganizationBinding(["org_acme", "org_consulting"], undefined),
    ).toEqual({
      requiresSelection: true,
      referenceId: null,
    })
    expect(
      selectOAuthOrganizationBinding(
        ["org_acme", "org_consulting"],
        "org_unrelated",
      ),
    ).toEqual({
      requiresSelection: true,
      referenceId: null,
    })
  })

  it("does not bind an active organization that is not a membership", () => {
    expect(
      selectOAuthOrganizationBinding(["org_acme"], "org_unrelated"),
    ).toEqual({
      requiresSelection: false,
      referenceId: "org_acme",
    })
  })

  it("requires organization setup when the user has no membership", () => {
    expect(selectOAuthOrganizationBinding([], undefined)).toEqual({
      requiresSelection: true,
      referenceId: null,
    })
  })
})

describe("OAuth consent organization", () => {
  it("uses the organization submitted by consent instead of mutable active state", () => {
    expect(
      resolveOAuthConsentReferenceId(
        ["org_acme", "org_consulting"],
        "org_acme",
        "org_consulting",
      ),
    ).toBe("org_consulting")
  })

  it("rejects a submitted organization that is not a membership", () => {
    expect(
      resolveOAuthConsentReferenceId(["org_acme"], "org_acme", "org_unrelated"),
    ).toBeNull()
  })

  it("rejects accepted consent when no organization was submitted", () => {
    expect(
      resolveOAuthConsentReferenceId(["org_acme"], "org_acme", null),
    ).toBeNull()
    expect(
      resolveOAuthConsentReferenceId(["org_acme"], "org_acme", undefined),
    ).toBe("org_acme")
  })

  it("keeps the submitted organization isolated to one consent request", async () => {
    expect(getOAuthConsentOrganizationId()).toBeUndefined()

    await withOAuthRequestContext(
      { submittedOrganizationId: "org_acme", clientId: "client_a" },
      async () => {
        await Promise.resolve()
        expect(getOAuthConsentOrganizationId()).toBe("org_acme")
        expect(getOAuthRequestClientId()).toBe("client_a")
      },
    )

    expect(getOAuthConsentOrganizationId()).toBeUndefined()
  })
})

describe("oauthAccessTokenClaims", () => {
  it("puts a grant id in the grant claim", () => {
    expect(oauthAccessTokenClaims("ogr_abc")).toEqual({
      [OAUTH_GRANT_CLAIM]: "ogr_abc",
    })
  })

  it("keeps a legacy org id in the org claim", () => {
    expect(oauthAccessTokenClaims("org_acme")).toEqual({
      [OAUTH_ORGANIZATION_CLAIM]: "org_acme",
    })
  })

  it("adds no claim without a reference", () => {
    expect(oauthAccessTokenClaims(undefined)).toEqual({})
  })
})

describe("readOAuthRequestClientId", () => {
  it("reads client_id from the authorize query", async () => {
    const request = new Request(
      "http://auth.test/oauth2/authorize?client_id=client_a&scope=openid",
    )
    expect(await readOAuthRequestClientId(request)).toBe("client_a")
  })

  it("reads client_id from the oauth_query body and leaves the body readable", async () => {
    const request = new Request("http://auth.test/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accept: true,
        oauth_query: "client_id=client_b&scope=openid&sig=x",
      }),
    })
    expect(await readOAuthRequestClientId(request)).toBe("client_b")
    expect(await request.json()).toMatchObject({ accept: true })
  })

  it("returns null when the request names no client", async () => {
    const request = new Request("http://auth.test/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(await readOAuthRequestClientId(request)).toBeNull()
  })
})
