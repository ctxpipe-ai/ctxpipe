import { describe, expect, it } from "vitest"

import { hideSecrets } from "./hide-secrets"

describe("hideSecrets", () => {
  it("drops the query of a signed URL", () => {
    expect(
      hideSecrets(
        "fallback: https://developer.atlassian.com/console/install/abc?signature=AYABeHVDAf5aXClr&product=confluence.",
      ),
    ).toBe("fallback: https://developer.atlassian.com/console/install/abc?…")
  })

  it("keeps the start of a long token only", () => {
    expect(
      hideSecrets("token ghp_0123456789abcdefghijklmnopqrstuvwxyz refused"),
    ).toBe("token ghp_… refused")
  })

  it("keeps plain text and a URL without a query", () => {
    const text = "The operation timed out at https://example.com/api/v1."
    expect(hideSecrets(text)).toBe(text)
  })
})
