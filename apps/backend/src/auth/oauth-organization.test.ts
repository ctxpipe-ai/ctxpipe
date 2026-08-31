import { describe, expect, it } from "vitest"
import {
  getOAuthConsentOrganizationId,
  resolveOAuthConsentReferenceId,
  selectOAuthOrganizationBinding,
  withOAuthConsentOrganizationId,
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

  it("keeps the submitted organization isolated to one consent request", async () => {
    expect(getOAuthConsentOrganizationId()).toBeNull()

    await withOAuthConsentOrganizationId("org_acme", async () => {
      await Promise.resolve()
      expect(getOAuthConsentOrganizationId()).toBe("org_acme")
    })

    expect(getOAuthConsentOrganizationId()).toBeNull()
  })
})
