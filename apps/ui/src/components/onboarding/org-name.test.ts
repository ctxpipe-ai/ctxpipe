import { describe, expect, it } from "vitest"

import {
  ORG_SLUG_MAX_LENGTH,
  orgNameFromEmail,
  orgSlugError,
  orgSlugFromName,
} from "./org-name"

describe("orgNameFromEmail", () => {
  it("names the organization after a work domain", () => {
    expect(orgNameFromEmail("pat@initech.io")).toBe("Initech")
    expect(orgNameFromEmail("a@eng.acme.co.uk")).toBe("Acme")
    expect(orgNameFromEmail("a@Acme.COM")).toBe("Acme")
  })

  it("suggests nothing for personal mail or a missing address", () => {
    expect(orgNameFromEmail("someone@gmail.com")).toBe("")
    expect(orgNameFromEmail("someone@outlook.co.uk")).toBe("")
    expect(orgNameFromEmail("someone@proton.me")).toBe("")
    expect(orgNameFromEmail("someone@example.com")).toBe("")
    expect(orgNameFromEmail(undefined)).toBe("")
    expect(orgNameFromEmail("no-at-sign")).toBe("")
  })
})

describe("orgSlugFromName", () => {
  it("makes a lowercase, hyphenated slug of at most 32 characters", () => {
    expect(orgSlugFromName("Acme Engineering")).toBe("acme-engineering")
    expect(orgSlugFromName("  R&D -- Team! ")).toBe("r-d-team")
    expect(orgSlugFromName("a".repeat(40))).toHaveLength(32)
    expect(orgSlugFromName("")).toBe("")
  })
})

describe("orgSlugError", () => {
  it("accepts what the server accepts", () => {
    expect(orgSlugError("acme")).toBeNull()
    expect(orgSlugError("acme-labs-2")).toBeNull()
  })

  it("refuses what the server refuses", () => {
    for (const bad of ["-acme", "acme-", "acme--labs", "Acme", "a_b", "a b"]) {
      expect(orgSlugError(bad), bad).not.toBeNull()
    }
    expect(orgSlugError("")).not.toBeNull()
    expect(orgSlugError("a".repeat(ORG_SLUG_MAX_LENGTH + 1))).not.toBeNull()
  })

  it("accepts every derived slug", () => {
    for (const name of [
      "Acme Labs",
      "  --Acme!!  ",
      "A & B / C",
      `${"a".repeat(31)} bcd`,
    ]) {
      const slug = orgSlugFromName(name)
      expect(orgSlugError(slug), name).toBeNull()
    }
  })
})
