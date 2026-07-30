import { describe, expect, it } from "vitest"
import {
  hasNotionScopeChanged,
  shouldShowNotionSetupComplete,
} from "./notion-setup-model"

const page = {
  externalId: "page-1",
  type: "page" as const,
  title: "Handbook",
}
const database = {
  externalId: "database-1",
  type: "database" as const,
  title: "People",
}

describe("Notion setup model", () => {
  it("shows completion when initial setup becomes live", () => {
    expect(
      shouldShowNotionSetupComplete(
        { setupPhase: "live", selectedResourceCount: 2 },
        false,
      ),
    ).toBe(true)
  })

  it("opens the scope editor when live scope management was requested", () => {
    expect(
      shouldShowNotionSetupComplete(
        { setupPhase: "live", selectedResourceCount: 2 },
        true,
      ),
    ).toBe(false)
  })

  it("treats reordered scope as unchanged", () => {
    expect(hasNotionScopeChanged([page, database], [database, page])).toBe(
      false,
    )
  })

  it("detects a changed resource selection", () => {
    expect(hasNotionScopeChanged([page], [page, database])).toBe(true)
  })
})
