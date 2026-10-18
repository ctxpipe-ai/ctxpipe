import { describe, expect, it } from "vitest"
import { chooseUpgradeBranch } from "./branch.js"

const BASE = "ctxpipe/upgrade/format-3"
const theirs = (branch: string) => ({ branch, ours: false })

describe("chooseUpgradeBranch", () => {
  it("uses the next free suffixed name when a pull request that is not ours holds the base name", () => {
    expect(chooseUpgradeBranch([theirs(BASE), theirs(`${BASE}-2`)], BASE)).toBe(
      `${BASE}-3`,
    )
  })

  it("fails with a reason after 10 suffixed names, and does not loop forever", () => {
    const taken = [
      BASE,
      ...Array.from({ length: 10 }, (_, i) => `${BASE}-${i + 2}`),
    ]
    expect(chooseUpgradeBranch(taken.slice(0, -1).map(theirs), BASE)).toBe(
      `${BASE}-11`,
    )
    expect(() => chooseUpgradeBranch(taken.map(theirs), BASE)).toThrow(
      `Pull requests that ctx| did not open use the upgrade branch ${BASE} and its next 10 suffixed names.`,
    )
  })
})
