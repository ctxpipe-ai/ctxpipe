import { describe, expect, it } from "vitest"

import { describeMigrateError } from "./describe-migrate-error.js"

describe("describeMigrateError", () => {
  it("names the SQLSTATE, the table and the constraint, and drops the Postgres detail and where text", () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "tokens_key"'),
      {
        code: "23505",
        schema: "public",
        table: "tokens",
        constraint: "tokens_key",
        detail: "Key (token)=(sk-fake-secret-value) already exists.",
        where: "SQL statement INSERT ... VALUES ('sk-fake-secret-value')",
      },
    )
    const wrapped = Object.assign(
      new Error("Failed query: ALTER TABLE x\nparams: sk-fake-secret-value"),
      { query: "ALTER TABLE  x\nADD COLUMN y text", cause: pgError },
    )
    const text = describeMigrateError(
      new Error("[migrate] failed", { cause: wrapped }),
    )
    expect(text).toContain("SQLSTATE 23505")
    expect(text).toContain("table public.tokens")
    expect(text).toContain("constraint tokens_key")
    expect(text).toContain("statement: ALTER TABLE x ADD COLUMN y text")
    expect(text).not.toContain("sk-fake-secret-value")
  })
})
