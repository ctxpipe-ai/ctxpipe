import { describe, expect, it } from "vitest"
import { applyCodesearchLogContract } from "./logger.js"

describe("codesearch log contract database errors", () => {
  it("strips Drizzle params and pg detail from a copied error", () => {
    const cause = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "repositories_git_url_org_id_unique"',
      ),
      {
        severity: "ERROR",
        code: "23505",
        detail:
          "Key (git_url, org_id)=(https://github.com/octocat/Spoon-Knife.git, org_secret) already exists.",
        hint: "Use the existing row",
        where: "Key (git_url)=(https://github.com/octocat/Spoon-Knife.git)",
        internalQuery:
          "insert into repositories values ('https://github.com/octocat/Spoon-Knife.git')",
        schema: "public",
        table: "repositories",
        constraint: "repositories_git_url_org_id_unique",
        routine: "_bt_check_unique",
      },
    )
    const error = new Error(
      'Failed query: insert into "repositories" ("git_url") values ($1)\nparams: https://github.com/octocat/Spoon-Knife.git',
      { cause },
    )
    const event: Record<string, unknown> = {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause,
      },
    }
    applyCodesearchLogContract(event)
    expect(cause.detail).toContain("Spoon-Knife")
    const emitted = event.error as {
      message: string
      cause: Record<string, unknown>
    }
    expect(emitted.message).toContain("Failed query:")
    expect(emitted.cause.code).toBe("23505")
    expect(emitted.cause.constraint).toBe("repositories_git_url_org_id_unique")
    expect(emitted.cause.table).toBe("repositories")
    expect(emitted.cause.schema).toBe("public")
    expect(emitted.cause.routine).toBe("_bt_check_unique")
    expect(emitted.cause.severity).toBe("ERROR")
    expect(emitted.cause.detail).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain("Spoon-Knife")
    expect(JSON.stringify(event)).not.toContain("params:")
  })
})