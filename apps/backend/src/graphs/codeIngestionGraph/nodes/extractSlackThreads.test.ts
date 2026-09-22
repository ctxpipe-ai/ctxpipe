import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState } from "../schemas.js"

const mocks = vi.hoisted(() => ({
  globFiles: vi.fn(),
  fetchFiles: vi.fn(),
  resolveSourceRepositoryId: vi.fn(),
  listLinearTeamKeys: vi.fn(),
}))

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: mocks.globFiles,
  fetchFiles: mocks.fetchFiles,
}))
vi.mock("./repositoryResolution.js", () => ({
  resolveSourceRepositoryId: mocks.resolveSourceRepositoryId,
}))
vi.mock("./linkLocatedPaths.js", () => ({
  listLinearTeamKeys: mocks.listLinearTeamKeys,
}))

import { toSlackThreadMarkdownFile } from "../../../services/slack/converter.js"
import {
  extractSlackThreads,
  parseSlackThreadMarkdown,
} from "./extractSlackThreads.js"

const THREAD_PATH =
  "slack/channels/eng-backend--C0123ABC/threads/2026/03/1709372400.123456/thread.md"
const THREAD = `---
source: slack
channel_id: "C0123ABC"
channel_name: "eng-backend"
is_private: false
thread_ts: "1709372400.123456"
team_id: "T1"
permalink: "https://acme.slack.com/archives/C0123ABC/p1709372400123456"
captured_at: "2026-03-02T12:00:00.000Z"
captured_by:
  handle: "tom"
  name: "Tom"
message_count: 2
participant_ids: ["U1","U2"]
oldest: "1709372400.123456"
latest: "1709372500.000001"
---

# Thread in #eng-backend

### Alice · 2026-03-02T09:00:00.000Z

Should we merge https://github.com/acme/api/pull/42? It closes ENG-123 and https://linear.app/acme/issue/OPS-4/rotate-keys. Not UTF-8 related.

### Bob · 2026-03-02T09:05:00.000Z

Yes. See https://github.com/acme/api/commit/abc too.

[diagram.png](./assets/diagram.png)
`

const fixtures: Record<string, string> = { [THREAD_PATH]: THREAD }

function state(
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: "repo_ctx",
    orgId: "org_1",
    targetHash: "abc",
    githubConnectionId: "con_gh",
    roots: ["./"],
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.globFiles.mockResolvedValue({
    entries: Object.keys(fixtures).map((path) => ({ type: "file", path })),
  })
  mocks.fetchFiles.mockImplementation(
    async (_repo: string, _org: string, paths: string[]) =>
      Object.fromEntries(paths.map((path) => [path, fixtures[path]])),
  )
  mocks.resolveSourceRepositoryId.mockResolvedValue("repo_api")
  mocks.listLinearTeamKeys.mockResolvedValue(["ENG"])
})

describe("renderer round trip", () => {
  it("parses what toSlackThreadMarkdownFile actually writes", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C0123ABC",
      channelName: "eng-backend",
      isPrivate: false,
      teamId: "T1",
      threadTs: "1709372400.123456",
      permalink: "https://acme.slack.com/archives/C0123ABC/p1709372400123456",
      capturedAt: "2026-03-02T12:00:00.000Z",
      capturedBy: { handle: "tom", name: "Tom" },
      messages: [
        {
          ts: "1709372400.123456",
          userId: "U1",
          userDisplay: "Alice",
          text: "Should we merge https://github.com/acme/api/pull/42? Closes ENG-123.",
        },
        {
          ts: "1709372500.000001",
          userId: "U2",
          userDisplay: "Bob",
          text: "Yes.",
        },
      ],
    })
    expect(file.path).toBe(
      "slack/channels/eng-backend--C0123ABC/threads/2024/03/1709372400.123456/thread.md",
    )
    const parsed = parseSlackThreadMarkdown(file.content)
    expect(parsed).toMatchObject({
      channelId: "C0123ABC",
      channelName: "eng-backend",
      threadTs: "1709372400.123456",
      permalink: "https://acme.slack.com/archives/C0123ABC/p1709372400123456",
      messageCount: 2,
    })
    expect(parsed?.messages).toHaveLength(2)
    expect(parsed?.messages[0]).toContain("Should we merge")
    expect(parsed?.excerpt).not.toContain("U1")
    expect(parsed?.excerpt).not.toContain("Alice ·")
  })
})

describe("parseSlackThreadMarkdown", () => {
  it("keeps message bodies and drops author headings and asset links", () => {
    const parsed = parseSlackThreadMarkdown(THREAD)
    expect(parsed).toMatchObject({
      channelId: "C0123ABC",
      channelName: "eng-backend",
      threadTs: "1709372400.123456",
      messageCount: 2,
      isPrivate: false,
    })
    expect(parsed?.messages).toHaveLength(2)
    expect(parsed?.messages[0]).toContain("Should we merge")
    expect(parsed?.excerpt).not.toContain("diagram.png")
    expect(parsed?.excerpt).not.toContain("Alice ·")
  })
})

describe("extractSlackThreads", () => {
  it("emits a Thread without user ids and references pull requests and issues", async () => {
    const { extractedObjects = [], extractedClaims = [] } =
      await extractSlackThreads(state())

    expect(extractedObjects).toHaveLength(1)
    const thread = extractedObjects[0]
    expect(thread).toMatchObject({
      kind: "Thread",
      deduplicationKey: "thr:slack:C0123ABC:1709372400.123456",
    })
    expect(thread?.name?.startsWith("#eng-backend: Should we merge")).toBe(true)
    expect(thread?.payload).toMatchObject({
      channel_id: "C0123ABC",
      channel_name: "eng-backend",
      permalink: "https://acme.slack.com/archives/C0123ABC/p1709372400123456",
      message_count: 2,
    })
    expect(JSON.stringify(thread?.payload)).not.toMatch(/U1|U2|"tom"|Tom/)

    expect(extractedClaims.map((claim) => claim.objectRef).sort()).toEqual([
      "iss:linear:ENG-123",
      "iss:linear:OPS-4",
      "prq:repo_api:42",
    ])
    for (const claim of extractedClaims) {
      expect(claim.subjectRef).toBe("thr:slack:C0123ABC:1709372400.123456")
      expect(claim.predicate).toBe("REFERENCES")
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_ctx", "abc"),
      ).toBe(true)
    }
  })

  it("only matches bare identifiers for known team keys and falls back to name-scoped PR keys", async () => {
    mocks.listLinearTeamKeys.mockResolvedValue([])
    mocks.resolveSourceRepositoryId.mockResolvedValue(undefined)
    const { extractedClaims = [] } = await extractSlackThreads(state())
    expect(extractedClaims.map((claim) => claim.objectRef).sort()).toEqual([
      "iss:linear:OPS-4",
      "prq:github:acme/api:42",
    ])
  })

  it("restricts to changed paths on partial ingest and skips malformed captures", async () => {
    expect(
      await extractSlackThreads(
        state({
          ingestMode: "partial",
          changedPaths: [
            "slack/channels/other--C9/threads/2026/01/1.1/thread.md",
          ],
        }),
      ),
    ).toEqual({})

    fixtures["slack/channels/bad--C2/threads/2026/03/2.2/thread.md"] =
      '---\nsource: slack\nchannel_name: "x"\n---\n# Thread in #x\n'
    try {
      const { extractedObjects = [] } = await extractSlackThreads(state())
      expect(extractedObjects.map((object) => object.deduplicationKey)).toEqual(
        ["thr:slack:C0123ABC:1709372400.123456"],
      )
    } finally {
      delete fixtures["slack/channels/bad--C2/threads/2026/03/2.2/thread.md"]
    }
  })
})
