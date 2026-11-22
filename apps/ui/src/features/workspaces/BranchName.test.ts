import { describe, expect, it } from "vitest"

import { branchNameTail } from "./BranchName"

describe("branchNameTail", () => {
  it("keeps the last whole words of a long name", () => {
    expect(
      branchNameTail("feature/2026-11-checkout-retry-with-idempotency-keys"),
    ).toBe("idempotency-keys")
  })

  it("gives a short name no tail", () => {
    expect(branchNameTail("release/2026-11")).toBe("")
  })

  it("keeps the last 10 characters of a long word", () => {
    expect(branchNameTail("feature/supercalifragilisticexpialidocious")).toBe(
      "alidocious",
    )
  })
})
