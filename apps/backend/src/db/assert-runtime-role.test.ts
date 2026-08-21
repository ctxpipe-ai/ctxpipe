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

  it("refuses pg boolean strings for BYPASSRLS", () => {
    expect(() =>
      assertRuntimeRoleDoesNotBypassRlsFromRow({
        rolname: "neondb_owner",
        rolbypassrls: "t",
      }),
    ).toThrow(/BYPASSRLS/)
  })

  it("refuses when pg_roles returns no row", () => {
    expect(() => assertRuntimeRoleDoesNotBypassRlsFromRow(undefined)).toThrow(
      /Could not resolve current_user/,
    )
  })

  it("allows ctxpipe_app without BYPASSRLS", () => {
    expect(() =>
      assertRuntimeRoleDoesNotBypassRlsFromRow({
        rolname: "ctxpipe_app",
        rolbypassrls: false,
      }),
    ).not.toThrow()
  })

  it("allows pg boolean string f", () => {
    expect(() =>
      assertRuntimeRoleDoesNotBypassRlsFromRow({
        rolname: "ctxpipe_app",
        rolbypassrls: "f",
      }),
    ).not.toThrow()
  })
})
