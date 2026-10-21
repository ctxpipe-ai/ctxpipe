import { execFile } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { projectWorkspaceSources } from "../../domain/workspace-sources/project.js"
import { diffSlice } from "../../domain/workspace-sources/slice-diff.js"
import {
  cleanupRemovedSources,
  type SliceWriter,
  syncConnectionSources,
} from "../../domain/workspace-sources/sync.js"
import { encodeSlackBotTokenForDb } from "../../lib/connection-config.js"
import {
  getSlackConnectionByConnectionId,
  type SlackConnection,
} from "../../models/slack-connector.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { connectorPathSegment } from "../connectors/path-segment.js"
import { gitFileBytes } from "../git/file-change.js"
import { getSlackThreadPath } from "./converter.js"
import { slackCaptureWorkspaceLinks } from "./mention-agent.js"
import {
  captureSlackThreadToSources,
  slackSourceAdapter,
} from "./source-adapter.js"

const execFileAsync = promisify(execFile)
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const env = () => parseEnv(process.env)

const ENG = "C0ENG0001"
const OPS = "C0OPS0001"
const NONE = "C0NONE001"
const BOT = "U0BOT0001"
const THREAD = "1790000000.000100"
const STATUS = "1790000700.000100"

let calls: string[] = []
let replies: Array<{ ts: string; user: string; text: string }> = []
/** A Slack error for a method and channel, by `method:channel`. */
let failures: Record<string, string | number> = {}
let channelState: Record<
  string,
  { is_member?: boolean; is_archived?: boolean; name?: string }
> = {}

function installSlack() {
  server.use(
    http.get("https://slack.com/api/:method", ({ params, request }) => {
      const method = String(params.method)
      const query = Object.fromEntries(new URL(request.url).searchParams)
      calls.push(method)
      const failure = failures[`${method}:${query.channel ?? ""}`]
      if (typeof failure === "number")
        return new HttpResponse(null, { status: failure })
      if (failure) return HttpResponse.json({ ok: false, error: failure })
      const channel = query.channel ?? ""
      switch (method) {
        case "conversations.info":
          return HttpResponse.json({
            ok: true,
            channel: {
              id: channel,
              name: channel === ENG ? "eng" : "ops",
              is_private: false,
              is_member: true,
              ...channelState[channel],
            },
          })
        case "conversations.replies":
          return HttpResponse.json({ ok: true, messages: replies })
        case "users.info":
          return HttpResponse.json({
            ok: true,
            user: { name: query.user?.toLowerCase(), real_name: "Person" },
          })
        case "chat.getPermalink":
          return HttpResponse.json({
            ok: true,
            permalink: `https://example.slack.com/archives/${channel}/p1`,
          })
        default:
          return HttpResponse.json({ ok: false, error: "unknown_method" })
      }
    }),
  )
}

const git = async (dir: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", dir, ...args])).stdout

/** The blobs of a real git repository, as the frame reads a Workspace head. */
async function blobs(dir: string) {
  return (await git(dir, "ls-files", "-s"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", path = ""] = line.split("\t")
      return { path, sha: meta.split(" ")[1] ?? "" }
    })
}

describe("Slack mention capture through Workspace sources (Postgres, msw, git)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let slack: string
  let connection: SlackConnection
  let engWorkspace: string
  let bothWorkspace: string
  const repos = new Map<string, string>()
  let revision = 0

  /** Write each slice as one commit into the Workspace's own git repository. */
  const write: SliceWriter = async (slice) => {
    const dir = repos.get(slice.workspaceId)
    if (!dir) throw new Error(`No repository for ${slice.workspaceId}`)
    const change = diffSlice(
      slice,
      (await blobs(dir)).map((blob) => blob.path),
    )
    for (const file of change.files) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true })
      await writeFile(join(dir, file.path), gitFileBytes(file))
    }
    for (const path of change.deletePaths) await rm(join(dir, path))
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", `${slice.provider} capture`)
  }
  const readExisting = async (workspaceId: string) =>
    blobs(repos.get(workspaceId) ?? "")
  const commits = async (workspaceId: string) =>
    Number(
      (await git(repos.get(workspaceId) ?? "", "rev-list", "--count", "HEAD"))
        .toString()
        .trim(),
    ) - 1
  const capture = (channelId: string) =>
    captureSlackThreadToSources({
      orgId: seed.orgId,
      env: env(),
      connection,
      channelId,
      threadTs: THREAD,
      capturedAt: "2026-10-01T00:00:00.000Z",
      excludeMessageTs: STATUS,
      write,
      readExisting,
    })
  const threadPath = getSlackThreadPath({
    layout: "source",
    channelId: ENG,
    channelName: "eng",
    threadTs: THREAD,
  })

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedSourcesOrg("slack_src")
    slack = await seed.addConnection("slack", {
      botTokenEnc: encodeSlackBotTokenForDb("xoxb-test", env()),
      teamId: `T0${seed.suffix}`.slice(0, 20),
      teamName: "Example",
      botUserId: BOT,
      status: "installed",
    })
    const found = await withOrgDbContext(seed.orgId, () =>
      getSlackConnectionByConnectionId(seed.orgId, slack),
    )
    if (!found) throw new Error("The Slack connection is missing")
    connection = found
    engWorkspace = await seed.addWorkspace("eng")
    bothWorkspace = await seed.addWorkspace("both")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  beforeEach(async () => {
    calls = []
    failures = {}
    channelState = {}
    replies = [
      { ts: THREAD, user: "U0PERSON1", text: "Root of the thread" },
      { ts: "1790000600.000100", user: "U0PERSON2", text: "First reply" },
      { ts: STATUS, user: BOT, text: "ctxpipe agent working…" },
    ]
    installSlack()
    for (const workspaceId of [engWorkspace, bothWorkspace]) {
      const repo = await seed.gitRepository()
      await repo.commit({ "README.md": "# Workspace\n" })
      repos.set(workspaceId, repo.dir)
    }
    revision += 1
    const at = (n: number) => String(revision * 10 + n).padStart(40, "0")
    const row = (sourceKey: string, channels: string[]) => ({
      sourceKey,
      provider: "slack" as const,
      connectionId: slack,
      scope: { channels },
      status: "ok" as const,
      statusDetail: null,
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: at(1),
      rows: [row("eng-channels", [ENG])],
    })
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: bothWorkspace,
      revision: at(2),
      rows: [row("all-channels", [ENG, OPS])],
    })
  })

  it("writes the thread into each Workspace that lists the channel, one commit each", async () => {
    const result = await capture(ENG)
    expect(result).toMatchObject({
      kind: "captured",
      capture: { status: "completed", messageCount: 2, threadPath },
    })
    if (result.kind !== "captured") return
    expect(result.workspaces.sort()).toEqual(
      [engWorkspace, bothWorkspace].sort(),
    )
    for (const workspaceId of [engWorkspace, bothWorkspace]) {
      const dir = repos.get(workspaceId) ?? ""
      expect(await commits(workspaceId)).toBe(1)
      const thread = await readFile(join(dir, threadPath), "utf-8")
      expect(thread).toContain("First reply")
      // The in-thread status reply is not context (ADR-025).
      expect(thread).not.toContain("ctxpipe agent working")
      expect((await blobs(dir)).map((blob) => blob.path)).toContain(
        "slack/channels/C0ENG0001/index.md",
      )
    }
  })

  it("keeps a hostile thread ts from the provider under the channel folder", async () => {
    const hostile = "../../../../.ctxpipe/workspace"
    replies = [
      { ts: THREAD, user: "U0PERSON1", text: "Root of the thread" },
      { ts: "1790000600.000100", user: "U0PERSON2", text: "First reply" },
    ]
    const result = await captureSlackThreadToSources({
      orgId: seed.orgId,
      env: env(),
      connection,
      channelId: ENG,
      threadTs: hostile,
      capturedAt: "2026-10-01T00:00:00.000Z",
      write,
      readExisting,
    })
    expect(result).toMatchObject({
      kind: "captured",
      capture: { status: "completed" },
    })
    const expected = `slack/channels/C0ENG0001/threads/NaN/NaN/${connectorPathSegment(hostile)}/thread.md`
    expect(expected).toContain("/-.-..-..-..-.ctxpipe-workspace/")
    for (const workspaceId of [engWorkspace, bothWorkspace]) {
      const paths = (await blobs(repos.get(workspaceId) ?? "")).map(
        (blob) => blob.path,
      )
      expect(paths).toContain(expected)
      for (const path of paths.filter((p) => p !== "README.md")) {
        expect(path.startsWith("slack/channels/C0ENG0001/")).toBe(true)
        for (const segment of path.split("/"))
          expect([".", "..", ""]).not.toContain(segment)
      }
    }
  })

  it("leaves out only the status reply of the capture", async () => {
    replies.push({
      ts: "1790000800.000100",
      user: BOT,
      text: "Earlier bot note",
    })
    await capture(ENG)
    const thread = await readFile(
      join(repos.get(engWorkspace) ?? "", threadPath),
      "utf-8",
    )
    expect(thread).toContain("Earlier bot note")
    expect(thread).not.toContain("ctxpipe agent working")
  })

  it(
    "keeps the truncated flag of a thread over 500 messages",
    {
      timeout: 60_000,
    },
    async () => {
      replies = Array.from({ length: 501 }, (_, index) => ({
        ts: `${1790000000 + index}.000100`,
        user: "U0PERSON1",
        text: `Message ${index}`,
      }))
      const result = await capture(ENG)
      expect(result).toMatchObject({
        kind: "captured",
        capture: { status: "completed", truncated: true, messageCount: 500 },
      })
    },
  )

  it("links each Workspace that got the thread to its thread file in the app", async () => {
    const result = await capture(ENG)
    if (result.kind !== "captured") throw new Error("Thread not captured")
    const slug = (name: string) =>
      `${name}-${seed.suffix.replaceAll("_", "-")}`.slice(0, 60)
    const pane = encodeURIComponent(`file:${encodeURIComponent(threadPath)}`)
    const links = await slackCaptureWorkspaceLinks({
      orgId: seed.orgId,
      workspaceIds: result.workspaces,
      threadPath,
      env: env(),
    })
    expect(links.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      ["both", "eng"].map((name) => ({
        name,
        url: `${env().AUTH_BASE_URL}/${seed.orgId}/ws/${slug(name)}?pane=${pane}`,
      })),
    )
  })

  it("writes only into the Workspace of a channel that one source lists", async () => {
    const result = await capture(OPS)
    expect(result.kind === "captured" && result.workspaces).toEqual([
      bothWorkspace,
    ])
    expect(await commits(engWorkspace)).toBe(0)
  })

  it("writes nothing when no Workspace lists the channel", async () => {
    expect(await capture(NONE)).toEqual({ kind: "no_source" })
    expect(calls).toEqual([])
    expect(await commits(engWorkspace)).toBe(0)
    expect(await commits(bothWorkspace)).toBe(0)
  })

  it("overwrites the snapshot of the thread root on a recapture", async () => {
    await capture(ENG)
    replies.splice(2, 0, {
      ts: "1790000650.000100",
      user: "U0PERSON1",
      text: "Second reply",
    })
    await capture(ENG)
    const dir = repos.get(engWorkspace) ?? ""
    const threads = (await blobs(dir)).filter((blob) =>
      blob.path.endsWith("/thread.md"),
    )
    expect(threads.map((blob) => blob.path)).toEqual([threadPath])
    expect(await readFile(join(dir, threadPath), "utf-8")).toContain(
      "Second reply",
    )
  })

  it("writes nothing and keeps the files when Slack fails", async () => {
    failures[`conversations.replies:${ENG}`] = "not_in_channel"
    expect(await capture(ENG)).toMatchObject({
      kind: "captured",
      capture: { status: "failed", errorCode: "not_in_channel" },
      workspaces: [],
    })
    expect(await commits(engWorkspace)).toBe(0)
  })

  it("keeps the captured threads of a channel removed from a source", async () => {
    await capture(ENG)
    const dir = repos.get(engWorkspace) ?? ""
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: "f".repeat(40),
      rows: [],
    })
    const writes = await cleanupRemovedSources({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: "f".repeat(40),
      removed: [
        { provider: "slack", connectionId: slack, scope: { channels: [ENG] } },
      ],
      adapters: { slack: slackSourceAdapter },
      write,
    })
    // A capture cannot be read again from Slack, so it is never deleted.
    expect(writes).toEqual([])
    expect(await readFile(join(dir, threadPath), "utf-8")).toContain(
      "First reply",
    )
  })

  it("reads nothing from Slack in a sync without a capture", async () => {
    const written: string[] = []
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: slack,
      env: env(),
      adapter: slackSourceAdapter,
      write: async (slice) => {
        written.push(slice.workspaceId)
      },
    })
    expect(written).toEqual([])
    expect(calls).toEqual([])
  })

  it("keeps a source ok when one channel is archived, and captures in the good channel", async () => {
    const OLD = "C0OLD0001"
    channelState[OLD] = { is_archived: true, name: "old" }
    const projected = await projectWorkspaceSources({
      orgId: seed.orgId,
      workspaceId: engWorkspace,
      revision: "e".repeat(40),
      text: `version: 1
sources:
  - id: eng-channels
    provider: slack
    connection: ${slack}
    channels: [${ENG}, ${OLD}]
`,
      env: env(),
      adapters: { slack: slackSourceAdapter },
    })
    expect(projected).toBeDefined()
    expect(
      await listWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId: engWorkspace,
      }),
    ).toMatchObject([
      {
        sourceKey: "eng-channels",
        status: "ok",
        statusDetail: "Channel #old is archived",
      },
    ])
    expect(await capture(ENG)).toMatchObject({
      kind: "captured",
      capture: { status: "completed" },
    })
    expect(await commits(engWorkspace)).toBe(1)
  })

  it("marks a source out of access when no channel is usable", async () => {
    channelState[ENG] = { is_archived: true }
    failures[`conversations.info:${OPS}`] = "channel_not_found"
    expect(
      await slackSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: slack,
        scope: { channels: [ENG, OPS] },
        env: env(),
      }),
    ).toBe(
      `Channel #eng is archived; Channel ${OPS} is not found, or the ctxpipe bot cannot see it`,
    )
  })

  // Slack sends a mention only from a channel that the bot is in, and an
  // invite changes nothing in ctxpipe. So a missing bot is a note, not a block.
  it("keeps a source ok when the bot is not in its channels yet", async () => {
    channelState[ENG] = { is_member: false }
    channelState[OPS] = { is_member: false }
    expect(
      await slackSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: slack,
        scope: { channels: [ENG, OPS] },
        env: env(),
      }),
    ).toEqual({
      okDetail:
        "Invite the ctxpipe bot to channel #eng; Invite the ctxpipe bot to channel #ops",
    })
  })

  it("checkAccess reports a revoked connection without a throw", async () => {
    const revoked = await seed.addConnection("slack", {
      teamId: "T0REVOKED1",
      status: "revoked",
    })
    expect(
      await slackSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: revoked,
        scope: { channels: [ENG] },
        env: env(),
      }),
    ).toBe("The Slack connection is not installed. Reconnect Slack.")
  })

  it("checkAccess reports a permanent problem behind a transient failure", async () => {
    failures[`conversations.info:${ENG}`] = 503
    channelState[OPS] = { is_member: false }
    const check = slackSourceAdapter.checkAccess
    expect(
      await check?.({
        orgId: seed.orgId,
        connectionId: slack,
        scope: { channels: [ENG, OPS] },
        env: env(),
      }),
    ).toEqual({ okDetail: "Invite the ctxpipe bot to channel #ops" })
    channelState = {}
    failures = {}
    expect(
      await check?.({
        orgId: seed.orgId,
        connectionId: slack,
        scope: { channels: [ENG, OPS] },
        env: env(),
      }),
    ).toBeNull()
  })
})
