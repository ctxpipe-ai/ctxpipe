import { describe, expect, it } from "vitest"

import {
  skippedFileCopy,
  skippedFileFixable,
  skippedFilesFixPrompt,
} from "./skipped-files"

const legacy = {
  path: "knowledge/apis/imported.md",
  reason: "malformed" as const,
  source: "legacy-overlay" as const,
}
const gitFile = {
  path: "knowledge/billing/tax.md",
  reason: "malformed" as const,
}

describe("skipped files", () => {
  it("names the cause of a legacy overlay file, and offers no fix for it", () => {
    expect(skippedFileCopy(legacy)).toBe(
      "Knowledge from before Workspaces. ctxpipe shows it from its database, so it cannot be fixed here.",
    )
    expect(skippedFileFixable(legacy)).toBe(false)
  })

  it("offers the agent for the front matter of a file of Git only", () => {
    expect(skippedFileCopy(gitFile)).toBe("Front matter is not valid")
    expect(skippedFileFixable(gitFile)).toBe(true)
    expect(
      skippedFileFixable({
        path: "repositories/app.md",
        reason: "duplicate_repository",
      }),
    ).toBe(false)
    expect(skippedFilesFixPrompt([gitFile])).toContain(gitFile.path)
  })

  it("names unresolved merge markers as the cause, and offers the agent to remove them", () => {
    const conflict = {
      path: "knowledge/billing/tax.md",
      reason: "merge_conflict" as const,
    }
    expect(skippedFileCopy(conflict)).toBe(
      "This file has unresolved merge markers. Keep the right version and remove the markers.",
    )
    expect(skippedFileFixable(conflict)).toBe(true)
    expect(skippedFilesFixPrompt([conflict])).toBe(
      "Hydrate skipped knowledge/billing/tax.md: This file has unresolved merge markers. Keep the right version and remove the markers. Keep the right version of each marked part of this file and remove the markers, then open the change.",
    )
  })
})
