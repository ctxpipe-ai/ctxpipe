import { describe, expect, it } from "vitest"
import { resolveSelectedOrganizationSlug } from "./selected-organization"

describe("resolveSelectedOrganizationSlug", () => {
  it("keeps the stored organization when the user still has it", () => {
    expect(resolveSelectedOrganizationSlug("beta", ["alpha", "beta"])).toBe(
      "beta",
    )
  })

  it("falls back to the first organization when the stored one is gone", () => {
    expect(resolveSelectedOrganizationSlug("gone", ["alpha", "beta"])).toBe(
      "alpha",
    )
  })

  it("uses the first organization when nothing is stored", () => {
    expect(resolveSelectedOrganizationSlug(null, ["alpha"])).toBe("alpha")
  })

  it("gives none when the user has no organization", () => {
    expect(resolveSelectedOrganizationSlug("gone", [])).toBeNull()
  })

  it("gives none while the list is unknown", () => {
    expect(resolveSelectedOrganizationSlug("beta", undefined)).toBeNull()
  })
})
