import { describe, expect, it } from "vitest"

import { tipMirrorSnapshotIsCurrent } from "./mirror-snapshot-age.js"

const pullRequest = (updatedAt: string, body = "# Pull request\n") =>
  `---\nsource: github\ntype: pull_request\nupdatedAt: ${updatedAt}\n---\n${body}`

describe("tipMirrorSnapshotIsCurrent", () => {
  it("drops an incoming snapshot that is older than the file on the tip", () => {
    expect(
      tipMirrorSnapshotIsCurrent(
        pullRequest("2026-10-30T10:00:00Z", "older\n"),
        pullRequest("2026-10-30T11:00:00Z", "newer\n"),
      ),
    ).toBe(true)
  })

  it("drops an incoming snapshot of the same age as the file on the tip", () => {
    expect(
      tipMirrorSnapshotIsCurrent(
        pullRequest("2026-10-30T10:00:00.000Z", "one\n"),
        pullRequest("2026-10-30T10:00:00Z", "two\n"),
      ),
    ).toBe(true)
  })

  it("keeps an incoming snapshot that is newer than the file on the tip", () => {
    expect(
      tipMirrorSnapshotIsCurrent(
        pullRequest("2026-10-30T12:00:00Z"),
        pullRequest("2026-10-30T11:00:00Z"),
      ),
    ).toBe(false)
  })

  it("reads the update time field of each provider", () => {
    for (const key of ["updatedAt", "updated_at", "last_edited_time"])
      expect(
        tipMirrorSnapshotIsCurrent(
          `---\n${key}: "2026-10-30T10:00:00Z"\n---\nolder\n`,
          `---\n${key}: "2026-10-30T11:00:00Z"\n---\nnewer\n`,
        ),
      ).toBe(true)
  })

  it("keeps an older incoming snapshot when the file on the tip has conflict markers", () => {
    expect(
      tipMirrorSnapshotIsCurrent(
        pullRequest("2026-10-30T10:00:00Z"),
        [
          "---",
          "source: github",
          "<<<<<<< ours",
          "updatedAt: 2026-10-30T11:00:00Z",
          "=======",
          "updatedAt: 2026-10-30T09:00:00Z",
          ">>>>>>> theirs",
          "---",
          "# Pull request",
          "",
        ].join("\n"),
      ),
    ).toBe(false)
    expect(
      tipMirrorSnapshotIsCurrent(
        pullRequest("2026-10-30T10:00:00Z"),
        pullRequest(
          "2026-10-30T11:00:00Z",
          "<<<<<<< ours\nbot comment\n=======\nother comment\n>>>>>>> theirs\n",
        ),
      ),
    ).toBe(false)
  })

  it("keeps the incoming snapshot when a side has no update time it can read", () => {
    const newer = pullRequest("2026-10-30T11:00:00Z")
    const older = pullRequest("2026-10-30T10:00:00Z")
    // The front matter of the file on the tip does not parse.
    expect(tipMirrorSnapshotIsCurrent(older, "---\nkey: [\n---\n")).toBe(false)
    // The file on the tip has no front matter.
    expect(tipMirrorSnapshotIsCurrent(older, "# Page\n")).toBe(false)
    // A provider that writes no update time.
    expect(
      tipMirrorSnapshotIsCurrent(
        "---\nsource: slack\n---\nolder\n",
        "---\nsource: slack\n---\nnewer\n",
      ),
    ).toBe(false)
    // An update time that is not a date.
    expect(tipMirrorSnapshotIsCurrent(older, pullRequest("unknown"))).toBe(
      false,
    )
    // The incoming file has no update time.
    expect(tipMirrorSnapshotIsCurrent("# Page\n", newer)).toBe(false)
  })
})
