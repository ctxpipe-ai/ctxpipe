import { describe, expect, it } from "vitest"

import { ownerUrlForMigrate } from "./owner-migrate-url.js"

describe("ownerUrlForMigrate", () => {
  it("rewrites local ctxpipe_app URLs to the Compose owner", () => {
    expect(
      ownerUrlForMigrate(
        "postgresql://ctxpipe_app:ctxpipe@localhost:5433/ctxpipe", // pragma: allowlist secret
      ),
    ).toBe(
      "postgresql://ctxpipe:ctxpipe@localhost:5433/ctxpipe", // pragma: allowlist secret
    )
  })

  it("rewrites the Compose service hostname", () => {
    expect(
      ownerUrlForMigrate(
        "postgresql://ctxpipe_app:secret@postgres:5432/ctxpipe",
      ),
    ).toBe("postgresql://ctxpipe:secret@postgres:5432/ctxpipe")
  })

  it("leaves Neon owner URLs unchanged", () => {
    const url =
      "postgresql://neondb_owner:pw@ep-x.aws.neon.tech/neondb?sslmode=require"
    expect(ownerUrlForMigrate(url)).toBe(url)
  })

  it("does not rewrite a hosted ctxpipe_app URL to Compose ctxpipe", () => {
    const url =
      "postgresql://ctxpipe_app:pw@ep-x-pooler.aws.neon.tech/neondb?sslmode=require"
    expect(ownerUrlForMigrate(url)).toBe(url)
  })
})
