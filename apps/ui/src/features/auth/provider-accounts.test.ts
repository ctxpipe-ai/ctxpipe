import { describe, expect, it } from "vitest"

import { accountsWithRowIds } from "./provider-accounts"

describe("accountsWithRowIds", () => {
  it("gives each account its row id as accountId, also when two providers share an account id", () => {
    const accounts = accountsWithRowIds([
      { id: "acc_row_atlassian", providerId: "atlassian", accountId: "583231" },
      { id: "acc_row_github", providerId: "github", accountId: "583231" },
    ])

    expect(accounts).toEqual([
      {
        id: "acc_row_atlassian",
        providerId: "atlassian",
        accountId: "acc_row_atlassian",
      },
      {
        id: "acc_row_github",
        providerId: "github",
        accountId: "acc_row_github",
      },
    ])
  })
})
