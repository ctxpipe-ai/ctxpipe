import { describe, expect, it } from "vitest"
import { resolveGithubSetupOrganization } from "./popup"

describe("resolveGithubSetupOrganization", () => {
  it("uses the organisation already linked to an installation update", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: "existing-org",
        selectedOrgSlug: null,
      }),
    ).toEqual({ kind: "existing", orgSlug: "existing-org" })
  })

  it("uses the preferred organisation for a new installation", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: null,
        selectedOrgSlug: "selected-org",
      }),
    ).toEqual({ kind: "new", orgSlug: "selected-org" })
  })

  it("requires a preferred organisation only for a new installation", () => {
    expect(
      resolveGithubSetupOrganization({
        existingOrgSlug: null,
        selectedOrgSlug: null,
      }),
    ).toEqual({ kind: "missing" })
  })
})
