import { describe, expect, it } from "vitest"

import { runReport } from "./workspace-upgrade-reingest.js"

function completed(workspace: Record<string, unknown>) {
  return {
    done: true as const,
    status: "completed" as const,
    error: null,
    output: {
      status: "partial",
      workspaces: [{ workspaceId: "ws_a", ...workspace }],
    },
  }
}

describe("runReport", () => {
  it("says how many files the publish withheld, with the rules and no path", () => {
    expect(
      runReport(
        completed({
          partial: 1,
          withheld: [
            { path: "knowledge/services/a.md", rules: ["suspected_injection"] },
            {
              path: "knowledge/services/b.md",
              rules: ["human_section", "suspected_injection"],
            },
          ],
        }),
        "ws_a",
      ),
    ).toEqual({
      status: "partial",
      report: [
        "2 files were withheld at publish because they failed the patch validator (rules: human_section, suspected_injection).",
      ],
    })
  })

  it("uses the singular for one withheld file", () => {
    expect(
      runReport(
        completed({
          partial: 1,
          withheld: [
            { path: "knowledge/services/a.md", rules: ["human_section"] },
          ],
        }),
        "ws_a",
      ).report,
    ).toEqual([
      "1 file was withheld at publish because it failed the patch validator (rules: human_section).",
    ])
  })

  it("keeps an empty report for a partial run with no withheld file and no failed step", () => {
    expect(runReport(completed({ partial: 1 }), "ws_a")).toEqual({
      status: "partial",
      report: [],
    })
  })
})
