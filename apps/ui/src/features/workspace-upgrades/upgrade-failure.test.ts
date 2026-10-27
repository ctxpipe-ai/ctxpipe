import { describe, expect, it } from "vitest"

import type { UpgradeFailure } from "./upgrade-failure"
import { upgradeFailureAllowsStartAgain } from "./upgrade-failure"

const failure = (code: UpgradeFailure["code"]): UpgradeFailure => ({
  code,
  step: null,
  repository: null,
  summary: "A summary.",
})

describe("upgradeFailureAllowsStartAgain", () => {
  it("offers Start again for a cause that a new run can pass", () => {
    for (const code of [
      "sandbox",
      "model",
      "publish_conflict",
      "timeout",
      "source_access",
      "workspace_write_access",
      "too_many_sources",
      "unknown",
    ] as const)
      expect(upgradeFailureAllowsStartAgain({ failure: failure(code) })).toBe(
        true,
      )
  })

  it("offers Start again for a failed item with no class", () => {
    expect(upgradeFailureAllowsStartAgain({ failure: null })).toBe(true)
  })
})
