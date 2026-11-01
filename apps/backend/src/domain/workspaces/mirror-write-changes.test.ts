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

const unchanged = { files: [], deletePaths: [], staleDropped: 1 }
const nothing = { files: [], deletePaths: [], staleDropped: 0 }

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
      staleDropped: 0,
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
    expect(await oneFile(same, same)).toEqual(nothing)
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

  const page = (time: string, title: string) =>
    `---\nsource: notion\nlast_edited_time: "${time}"\n---\n# ${title}\n`

  it("drops only the stale page of a write and keeps a page in another directory", async () => {
    const newerB = page("2026-10-30T12:00:00Z", "B2")
    expect(
      await mirrorWriteChanges(
        {
          files: [
            {
              path: "pages/a/index.md",
              content: page("2026-10-30T10:00:00Z", "A1"),
            },
            { path: "pages/b/index.md", content: newerB },
          ],
          deletePaths: [],
        },
        tip({
          "pages/a/index.md": page("2026-10-30T11:00:00Z", "A2"),
          "pages/b/index.md": page("2026-10-30T11:00:00Z", "B1"),
        }),
      ),
    ).toEqual({
      files: [{ path: "pages/b/index.md", content: newerB }],
      deletePaths: [],
      staleDropped: 1,
    })
  })

  it("drops the index and the table of a database with a stale row, and keeps a fresh row", async () => {
    const freshRow = page("2026-10-30T12:00:00Z", "A2")
    const result = await mirrorWriteChanges(
      {
        files: [
          { path: "databases/db/rows/a/index.md", content: freshRow },
          {
            path: "databases/db/rows/b/index.md",
            content: page("2026-10-30T10:00:00Z", "B1"),
          },
          {
            path: "databases/db/index.md",
            content: "# Database\n- A2\n- B1\n",
          },
          { path: "databases/db/table.csv", content: "title\nA2\nB1\n" },
          { path: "databases/other/index.md", content: "# Other\n" },
        ],
        deletePaths: [],
      },
      tip({
        "databases/db/rows/a/index.md": page("2026-10-30T11:00:00Z", "A1"),
        "databases/db/rows/b/index.md": page("2026-10-30T11:00:00Z", "B2"),
        "databases/db/index.md": "# Database\n- A1\n- B2\n",
        "databases/db/table.csv": "title\nA1\nB2\n",
      }),
    )
    expect(result.files.map((file) => file.path)).toEqual([
      "databases/db/rows/a/index.md",
      "databases/other/index.md",
    ])
    expect(result.staleDropped).toBe(3)
  })

  it("keeps the deletes of a write that has a stale file", async () => {
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
    ).toEqual({ files: [], deletePaths: ["comment.md"], staleDropped: 1 })
  })

  it("reads the first update time field that parses", async () => {
    expect(
      await oneFile(
        '---\nupdatedAt: unknown\nupdated_at: "2026-10-30T10:00:00Z"\n---\nolder\n',
        '---\nupdatedAt: unknown\nupdated_at: "2026-10-30T11:00:00Z"\n---\nnewer\n',
      ),
    ).toEqual(unchanged)
  })

  it("keeps only the deletes of paths on the tip", async () => {
    expect(
      await mirrorWriteChanges(
        { files: [], deletePaths: ["gone.md", "kept.md"] },
        tip({ "kept.md": "# Kept\n" }),
      ),
    ).toEqual({ files: [], deletePaths: ["kept.md"], staleDropped: 0 })
  })
})
