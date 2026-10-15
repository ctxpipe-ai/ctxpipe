import { describe, expect, it } from "vitest"
import {
  checkSourcePath,
  githubSourcePath,
  sourcePathFor,
} from "./source-file.js"
import { parseSourceFile, renderSourceFile } from "./source-file-text.js"

/** The provider examples of ADR-050, revision 2026-10-16. */
const examples: Array<{ path: string; text: string; scope: unknown }> = [
  {
    path: "sources/github/acme/checkout-api.md",
    text: `---
provider: github
connection: con_7Hq2xVn4
repository: acme/checkout-api
ref: release
---

The payment API. Use it for questions about checkout, refunds, and card tokens.
`,
    scope: { repository: "acme/checkout-api", ref: "release" },
  },
  {
    path: "sources/linear/eng.md",
    text: `---
provider: linear
connection: con_Lr81kQe0
teams: [ENG, OPS]
customerRequests: exclude
---

Engineering and operations work. Customer requests stay in the support Workspace.
`,
    scope: { teams: ["ENG", "OPS"], customerRequests: "exclude" },
  },
  {
    path: "sources/notion/handbook.md",
    text: `---
provider: notion
connection: con_Nt3pW9za
pages:
  - id: 1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9
    title: Engineering handbook
databases:
  - id: 0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e
    title: Runbooks
---
`,
    scope: {
      pages: [
        {
          id: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
          title: "Engineering handbook",
        },
      ],
      databases: [
        { id: "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e", title: "Runbooks" },
      ],
    },
  },
  {
    path: "sources/slack/incidents.md",
    text: `---
provider: slack
connection: con_Sk5mRt2b
channels: [C0123ABCD, C0456EFGH]
---

Incident and release channels.
`,
    scope: { channels: ["C0123ABCD", "C0456EFGH"] },
  },
  {
    path: "sources/pagerduty/on-call.md",
    text: `---
provider: pagerduty
connection: con_Pd9cXy1u
services: [PSVC001, PSVC002]
---
`,
    scope: { services: ["PSVC001", "PSVC002"] },
  },
  {
    path: "sources/confluence/architecture.md",
    text: `---
provider: confluence
connection: con_Cf4hJk8s
spaces:
  - key: ARCH
    pages: all
  - key: OPS
    pages: ["12345", "67890"]
---
`,
    scope: {
      spaces: [
        { key: "ARCH", pages: "all" },
        { key: "OPS", pages: ["12345", "67890"] },
      ],
    },
  },
]

function failure(path: string, text: string): string {
  const parsed = parseSourceFile(path, text)
  if (parsed.ok) throw new Error(`${path} parsed, but it must fail`)
  return parsed.detail
}

describe("parseSourceFile", () => {
  it.each(examples)("parses the ADR example $path", ({ path, text, scope }) => {
    const parsed = parseSourceFile(path, text)
    expect(parsed).toMatchObject({
      ok: true,
      source: { path, scope },
    })
  })

  it("gives the provider, connection, and body of a file", () => {
    const parsed = parseSourceFile(examples[0].path, examples[0].text)
    expect(parsed).toEqual({
      ok: true,
      source: {
        path: "sources/github/acme/checkout-api.md",
        provider: "github",
        connectionId: "con_7Hq2xVn4",
        scope: { repository: "acme/checkout-api", ref: "release" },
      },
      body: "\nThe payment API. Use it for questions about checkout, refunds, and card tokens.\n",
    })
  })

  it.each(["id", "kind"])("refuses the key %s", (key) => {
    const detail = failure(
      "sources/slack/incidents.md",
      `---\n${key}: incidents\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD]\n---\n`,
    )
    expect(detail).toContain(key)
  })

  it("refuses an unknown scope key, also for a provider whose schema strips keys", () => {
    expect(
      failure(
        "sources/linear/eng.md",
        "---\nprovider: linear\nconnection: con_Lr81kQe0\nteams: [ENG]\nlabels: [bug]\n---\n",
      ),
    ).toContain("labels")
    expect(
      failure(
        "sources/github/acme/web.md",
        "---\nprovider: github\nconnection: con_1\nrepository: acme/web\nrepositories: [acme/api]\n---\n",
      ),
    ).toContain("repositories")
  })

  it("refuses a provider that differs from the folder", () => {
    expect(
      failure(
        "sources/linear/eng.md",
        "---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD]\n---\n",
      ),
    ).toMatch(/folder/)
  })

  it("keeps the provider and connection of an invalid file for its row", () => {
    expect(
      parseSourceFile(
        "sources/slack/incidents.md",
        "---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: []\n---\n",
      ),
    ).toMatchObject({
      ok: false,
      path: "sources/slack/incidents.md",
      provider: "slack",
      connectionId: "con_Sk5mRt2b",
    })
  })

  it("refuses a file with no front matter or with a front matter that is not a map", () => {
    expect(failure("sources/slack/a.md", "Only text\n")).toMatch(/front matter/)
    expect(failure("sources/slack/a.md", "---\n- a\n- b\n---\n")).toMatch(/map/)
  })

  it("refuses a file over 64 KiB", () => {
    const text = `---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD]\n---\n${"x".repeat(64 * 1024)}`
    expect(failure("sources/slack/a.md", text)).toMatch(/64 KiB/)
  })

  it("refuses an alias bomb", () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]']
    for (let i = 1; i < 10; i++) {
      const prev = String.fromCharCode(96 + i)
      const next = String.fromCharCode(97 + i)
      lines.push(
        `${next}: &${next} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`,
      )
    }
    const text = `---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD]\n${lines.join("\n")}\n---\n`
    expect(failure("sources/slack/a.md", text)).toMatch(/alias/i)
  })

  it("gives the path reason for a bad path", () => {
    expect(
      failure(
        "sources/slack/../secrets.md",
        "---\nprovider: slack\nconnection: con_Sk5mRt2b\nchannels: [C0123ABCD]\n---\n",
      ),
    ).toMatch(/segment/)
  })
})

describe("checkSourcePath", () => {
  it.each([
    "sources/github/acme/checkout-api.md",
    "sources/linear/eng.md",
    "sources/slack/team-a/incidents.md",
    "sources/github/acme/web.v2.md",
  ])("accepts %s", (path) => {
    expect(checkSourcePath(path)).toMatchObject({ ok: true })
  })

  it("gives the provider folder", () => {
    expect(checkSourcePath("sources/notion/handbook.md")).toEqual({
      ok: true,
      provider: "notion",
    })
  })

  it.each([
    ["/sources/linear/eng.md", /sources\//],
    ["./sources/linear/eng.md", /sources\//],
    ["sources/linear/../eng.md", /segment/],
    ["sources/../linear/eng.md", /provider/],
    ["sources/linear/Eng.md", /segment/],
    ["sources/linear/eng", /\.md/],
    ["sources/linear/.eng.md", /segment/],
    ["sources/jira/eng.md", /provider/],
    ["sources/eng.md", /sources\/<provider>/],
    ["sources/linear/a/b/eng.md", /sources\/<provider>/],
    ["knowledge/linear/eng.md", /sources\//],
    [`sources/linear/${"a".repeat(101)}.md`, /segment/],
    // Each segment is also a part of a pull request branch name.
    ["sources/linear/a..b.md", /segment/],
    ["sources/linear/team.lock/eng.md", /segment/],
    ["sources/linear/eng.lock.md", /segment/],
    ["sources/linear/team./eng.md", /segment/],
  ])("refuses %s", (path, reason) => {
    const checked = checkSourcePath(path)
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.reason).toMatch(reason)
  })
})

describe("new source paths", () => {
  it("names a GitHub source by owner and name in lowercase", () => {
    expect(githubSourcePath("Acme", "Checkout_API")).toBe(
      "sources/github/acme/checkout_api.md",
    )
    expect(checkSourcePath(githubSourcePath("acme", ".github")).ok).toBe(true)
  })

  it("names another source from its label, with a free suffix", () => {
    expect(sourcePathFor("linear", "Eng & Ops")).toBe(
      "sources/linear/eng-ops.md",
    )
    expect(sourcePathFor("linear", "")).toBe("sources/linear/linear.md")
    expect(
      sourcePathFor(
        "linear",
        "",
        new Set(["sources/linear/linear.md", "sources/linear/linear-2.md"]),
      ),
    ).toBe("sources/linear/linear-3.md")
  })
})

describe("renderSourceFile", () => {
  it.each(
    examples,
  )("gives the same source and body after a round trip of $path", ({
    path,
    text,
  }) => {
    const parsed = parseSourceFile(path, text)
    if (!parsed.ok) throw new Error(parsed.detail)
    const again = parseSourceFile(
      path,
      renderSourceFile(parsed.source, parsed.body),
    )
    expect(again).toEqual(parsed)
  })

  it("keeps the body byte for byte", () => {
    const body = "\r\n  Two spaces, a CRLF, and ---\n---\nno final newline"
    const text = renderSourceFile(
      {
        path: "sources/slack/a.md",
        provider: "slack",
        connectionId: "con_Sk5mRt2b",
        scope: { channels: ["C0123ABCD"] },
      },
      body,
    )
    const parsed = parseSourceFile("sources/slack/a.md", text)
    expect(parsed).toMatchObject({ ok: true, body })
  })
})
