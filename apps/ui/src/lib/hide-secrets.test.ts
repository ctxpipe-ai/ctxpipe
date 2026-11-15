import { describe, expect, it } from "vitest"

import { hideSecrets } from "./hide-secrets"

describe("hideSecrets", () => {
  it("drops the query of a signed URL and keeps a UUID in its path", () => {
    expect(
      hideSecrets(
        "fallback: https://developer.atlassian.com/console/install/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43?signature=AYABeHVDAf5aXClr&product=confluence.",
      ),
    ).toBe(
      "fallback: https://developer.atlassian.com/console/install/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43?….",
    )
  })

  it("keeps the start of a long token only", () => {
    expect(
      hideSecrets("GitHub refused ghp_0123456789abcdefghijklmnopqrstuvwxyz"),
    ).toBe("GitHub refused ghp_…")
  })

  it("hides a short secret by its context", () => {
    expect(hideSecrets("Authorization: Bearer abc123 was refused")).toBe(
      "Authorization: Bearer … was refused",
    )
    expect(hideSecrets("bad client_secret=s3cr3t, retry")).toBe(
      "bad client_secret=…, retry",
    )
    expect(hideSecrets('{"password": "hunter2"}')).toBe('{"password": "…"}')
    expect(hideSecrets("api_key: k-123")).toBe("api_key: …")
    expect(hideSecrets("token abc123 was refused")).toBe("token … was refused")
    expect(hideSecrets("the secret s3cr3t-v4lue leaked")).toBe(
      "the secret … leaked",
    )
  })

  it("keeps plain text and a URL without a query", () => {
    const text =
      "The token check timed out at https://example.com/api/v1 (key not found)."
    expect(hideSecrets(text)).toBe(text)
  })

  it("keeps the final period, and hides a fragment as a fragment", () => {
    expect(hideSecrets("See https://example.com/a?sig=x.")).toBe(
      "See https://example.com/a?….",
    )
    expect(hideSecrets("See https://example.com/a#tok=x")).toBe(
      "See https://example.com/a#…",
    )
  })

  it("keeps ordinary words that start with auth", () => {
    expect(hideSecrets("authentication: failed")).toBe("authentication: failed")
    expect(hideSecrets("auth_token=abc")).toBe("auth_token=…")
  })
})
