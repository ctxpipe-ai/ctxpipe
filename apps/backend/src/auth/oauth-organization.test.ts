import { describe, expect, it } from "vitest"
import { selectOAuthOrganizationBinding } from "./oauth-organization.js"

describe("selectOAuthOrganizationBinding", () => {
  it("binds a single membership without another selection screen", () => {
    expect(selectOAuthOrganizationBinding(["org_acme"], undefined)).toEqual({
      requiresSelection: false,
      referenceId: "org_acme",
    })
  })

  it("requires an explicit choice for every multi-organization authorization", () => {
    expect(
      selectOAuthOrganizationBinding(
        ["org_acme", "org_consulting"],
        "org_acme",
      ),
    ).toEqual({
      requiresSelection: true,
      referenceId: "org_acme",
    })
  })

  it("does not bind an active organization that is not a membership", () => {
    expect(
      selectOAuthOrganizationBinding(["org_acme"], "org_unrelated"),
    ).toEqual({
      requiresSelection: false,
      referenceId: "org_acme",
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

  it("requires organization setup when the user has no membership", () => {
    expect(selectOAuthOrganizationBinding([], undefined)).toEqual({
      requiresSelection: true,
      referenceId: null,
    })
  })
})
