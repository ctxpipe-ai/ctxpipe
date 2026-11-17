import { describe, expect, it } from "vitest"

import type { UpgradeFailure } from "./upgrade-failure"
import {
  upgradeFailedItemPrompt,
  upgradeFailureAllowsStartAgain,
} from "./upgrade-failure"

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

describe("upgradeFailedItemPrompt", () => {
  it("ends the recorded cause with a period before the request", () => {
    const item = { title: "Upgrade to format 3", failureReason: null }
    expect(
      upgradeFailedItemPrompt({
        ...item,
        failure: {
          ...failure("repository_too_large"),
          summary: "stdout maxBuffer length exceeded",
        },
      }),
    ).toBe(
      'The upgrade "Upgrade to format 3" of this Workspace failed. ctxpipe recorded: stdout maxBuffer length exceeded. Find the cause, and tell me how to fix it.',
    )
    expect(
      upgradeFailedItemPrompt({
        ...item,
        failure: null,
        failureReason: "spawn git EAGAIN",
      }),
    ).toBe(
      'The upgrade "Upgrade to format 3" of this Workspace failed. ctxpipe recorded: spawn git EAGAIN. Find the cause, and tell me how to fix it.',
    )
  })

  it("keeps the period of a cause that has one", () => {
    expect(
      upgradeFailedItemPrompt({
        title: "Upgrade to format 3",
        failure: { ...failure("unknown"), summary: "The run stopped." },
        failureReason: null,
      }),
    ).toContain("ctxpipe recorded: The run stopped. Find the cause")
  })
})
