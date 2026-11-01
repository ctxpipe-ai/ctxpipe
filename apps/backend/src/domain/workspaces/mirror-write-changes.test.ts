import { describe, expect, it } from "vitest"

import { mirrorWriteChanges } from "./mirror-write-changes.js"

const pullRequest = (updatedAt: string, body = "# Pull request\n") =>
  `---\nsource: github\ntype: pull_request\nupdatedAt: ${updatedAt}\n---\n${body}`

/** A tip that holds these files. */
const tip =
  (files: Record<string, string>) =>
  async (path: string): Promise<Buffer | null> =>
    path in files ? Buffer.from(files[path] ?? "") : null

/** The changes of a write of one file onto a tip with one file at that path. */
const oneFile = (incoming: string, onTip: string) =>
  mirrorWriteChanges(
    { files: [{ path: "pr.md", content: incoming }], deletePaths: [] },
    tip({ "pr.md": onTip }),
  )

const unchanged = { files: [], deletePaths: [] }

describe("mirrorWriteChanges", () => {
  it("drops the write when the file on the tip is a strictly newer snapshot", async () => {
    expect(
      await oneFile(
        pullRequest("2026-10-30T10:00:00Z", "older\n"),
        pullRequest("2026-10-30T11:00:00Z", "newer\n"),
      ),
    ).toEqual(unchanged)
  })

  it("keeps an incoming snapshot with the same update time as the file on the tip", async () => {
    // A Linear comment does not change the issue time, and Notion keeps the
    // edit time to the minute.
    const incoming = pullRequest("2026-10-30T10:00:00.000Z", "new comment\n")
    expect(
      await oneFile(incoming, pullRequest("2026-10-30T10:00:00Z", "before\n")),
    ).toEqual({
      files: [{ path: "pr.md", content: incoming }],
      deletePaths: [],
    })
  })

  it("keeps an incoming snapshot that is newer than the file on the tip", async () => {
    const incoming = pullRequest("2026-10-30T12:00:00Z")
    expect(
      await oneFile(incoming, pullRequest("2026-10-30T11:00:00Z")),
    ).toMatchObject({ files: [{ content: incoming }] })
  })

  it("skips a file that is byte-identical to the file on the tip", async () => {
    const same = pullRequest("2026-10-30T12:00:00Z")
    expect(await oneFile(same, same)).toEqual(unchanged)
  })

  it("reads the update time field of each provider", async () => {
    for (const key of ["updatedAt", "updated_at", "last_edited_time"])
      expect(
        await oneFile(
          `---\n${key}: "2026-10-30T10:00:00Z"\n---\nolder\n`,
          `---\n${key}: "2026-10-30T11:00:00Z"\n---\nnewer\n`,
        ),
      ).toEqual(unchanged)
  })

  it("keeps an older incoming snapshot when the file on the tip has conflict markers", async () => {
    const incoming = pullRequest("2026-10-30T10:00:00Z")
    expect(
      await oneFile(
        incoming,
        pullRequest(
          "2026-10-30T11:00:00Z",
          "<<<<<<< ours\nbot comment\n=======\nother comment\n>>>>>>> theirs\n",
        ),
      ),
    ).toMatchObject({ files: [{ content: incoming }] })
  })

  it("counts a newer file on the tip with marker-like lines in a fenced code block", async () => {
    expect(
      await oneFile(
        pullRequest("2026-10-30T10:00:00Z"),
        pullRequest(
          "2026-10-30T11:00:00Z",
          "```diff\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n```\n",
        ),
      ),
    ).toEqual(unchanged)
  })

  it("counts a newer file on the tip with only part of a conflict sequence", async () => {
    expect(
      await oneFile(
        pullRequest("2026-10-30T10:00:00Z"),
        pullRequest("2026-10-30T11:00:00Z", "<<<<<<< quoted line\n"),
      ),
    ).toEqual(unchanged)
  })

  it("keeps the incoming snapshot when a side has no update time it can read", async () => {
    const newer = pullRequest("2026-10-30T11:00:00Z")
    const older = pullRequest("2026-10-30T10:00:00Z")
    for (const [incoming, onTip] of [
      // The front matter of the file on the tip does not parse.
      [older, "---\nkey: [\n---\n"],
      // The file on the tip has no front matter.
      [older, "# Page\n"],
      // A provider that writes no update time.
      ["---\nsource: slack\n---\nolder\n", "---\nsource: slack\n---\nnewer\n"],
      // An update time that is not a date.
      [older, pullRequest("unknown")],
      // The incoming file has no update time.
      ["# Page\n", newer],
    ] as const)
      expect(await oneFile(incoming, onTip)).toMatchObject({
        files: [{ content: incoming }],
      })
  })

  it("drops the whole write when one row is stale, also the files with no update time", async () => {
    const page = (time: string, title: string) =>
      `---\nsource: notion\nlast_edited_time: "${time}"\n---\n# ${title}\n`
    expect(
      await mirrorWriteChanges(
        {
          files: [
            { path: "db/a.md", content: page("2026-10-30T12:00:00Z", "A2") },
            { path: "db/b.md", content: page("2026-10-30T10:00:00Z", "B1") },
            { path: "db/index.md", content: "# Database\n- A2\n- B1\n" },
            { path: "db/table.csv", content: "title\nA2\nB1\n" },
          ],
          deletePaths: [],
        },
        tip({
          "db/a.md": page("2026-10-30T11:00:00Z", "A1"),
          "db/b.md": page("2026-10-30T11:00:00Z", "B2"),
          "db/index.md": "# Database\n- A1\n- B2\n",
          "db/table.csv": "title\nA1\nB2\n",
        }),
      ),
    ).toEqual(unchanged)
  })

  it("drops the deletes of a stale write", async () => {
    expect(
      await mirrorWriteChanges(
        {
          files: [
            { path: "pr.md", content: pullRequest("2026-10-30T10:00:00Z") },
          ],
          deletePaths: ["comment.md"],
        },
        tip({
          "pr.md": pullRequest("2026-10-30T11:00:00Z"),
          "comment.md": "# Comment\n",
        }),
      ),
    ).toEqual(unchanged)
  })

  it("keeps only the deletes of paths on the tip", async () => {
    expect(
      await mirrorWriteChanges(
        { files: [], deletePaths: ["gone.md", "kept.md"] },
        tip({ "kept.md": "# Kept\n" }),
      ),
    ).toEqual({ files: [], deletePaths: ["kept.md"] })
  })
})
