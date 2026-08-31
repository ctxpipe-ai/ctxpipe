import { describe, expect, it } from "vitest"
import { selectOAuthOrganizationBinding } from "./oauth-organization.js"

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
