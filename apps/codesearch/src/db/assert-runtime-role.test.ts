import { describe, expect, it } from "vitest"

import { assertRuntimeRoleDoesNotBypassRlsFromRow } from "./assert-runtime-role.js"

describe("assertRuntimeRoleDoesNotBypassRlsFromRow", () => {
  it("refuses a role with BYPASSRLS", () => {
    expect(() =>
      assertRuntimeRoleDoesNotBypassRlsFromRow({
        rolname: "ctxpipe",
        rolbypassrls: true,
      }),
    ).toThrow(/BYPASSRLS/)
  })

  it("allows ctxpipe_app without BYPASSRLS", () => {
    expect(() =>
      assertRuntimeRoleDoesNotBypassRlsFromRow({
        rolname: "ctxpipe_app",
        rolbypassrls: false,
      }),
    ).not.toThrow()
  })
})
