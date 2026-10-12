import { HttpResponse, http } from "msw"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { encodeSlackBotTokenForDb } from "../../lib/connection-config.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { gitBlobSha } from "../connectors/assets.js"
import { slackSourceAdapter } from "./source-adapter.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()
const env = () => parseEnv(process.env)

const ENG = "C0ENG0001"
const OPS = "C0OPS0001"
const BOT = "U0BOT0001"
const thread = (channel: string) =>
  channel === ENG ? "1790000000.000100" : "1790000500.000100"
const NOW = 1790100000 * 1000

type Call = { method: string; query: Record<string, string> }
let calls: Call[] = []
/** A Slack error for a method and channel, by `method:channel`. */
let failures: Record<string, string | number> = {}
let channelState: Record<
  string,
  { is_archived?: boolean; is_member?: boolean }
> = {}

function installSlack() {
  server.use(
    http.get("https://slack.com/api/:method", ({ params, request }) => {
      const method = String(params.method)
      const query = Object.fromEntries(new URL(request.url).searchParams)
      calls.push({ method, query })
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
        case "conversations.history":
          return HttpResponse.json({
            ok: true,
            messages: [
              { ts: "1790050000.000100", user: "U0PERSON1", text: "hi" },
              {
                ts: thread(channel),
                user: "U0PERSON1",
                text: "Root",
                reply_count: 2,
              },
            ],
          })
        case "conversations.replies":
          return HttpResponse.json({
            ok: true,
            messages: [
              { ts: query.ts, user: "U0PERSON1", text: `Root of ${channel}` },
              { ts: "1790000600.000100", user: "U0PERSON2", text: "Reply" },
              {
                ts: "1790000700.000100",
                user: BOT,
                text: "ctx| agent working…",
              },
            ],
          })
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

describe("Slack source adapter on the sync frame (Postgres, msw)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let slack: string
  let engWorkspace: string
  let bothWorkspace: string
  let revision = 0

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
    engWorkspace = await seed.addWorkspace("eng")
    bothWorkspace = await seed.addWorkspace("both")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(async () => {
    // Pin the clock so the backfill window holds the fixture threads.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW })
    calls = []
    failures = {}
    channelState = {}
    installSlack()
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

  async function sync(
    extra: Partial<Parameters<typeof syncConnectionSources>[0]> = {},
  ) {
    const writes = new Map<string, WorkspaceSliceWrite>()
    await syncConnectionSources({
      orgId: seed.orgId,
      connectionId: slack,
      env: env(),
      adapter: slackSourceAdapter,
      write: async (write) => {
        writes.set(write.workspaceId, write)
      },
      ...extra,
    })
    const paths = (workspaceId: string) =>
      (writes.get(workspaceId)?.files ?? []).map((file) => file.path).sort()
    return { writes, paths }
  }

  const status = async (workspaceId: string) =>
    (await listWorkspaceSourceRows({ orgId: seed.orgId, workspaceId }))[0]
  const count = (method: string) =>
    calls.filter((call) => call.method === method).length

  it("reads each channel one time and writes each Workspace its own channels", async () => {
    const { paths, writes } = await sync()
    const engThread = `slack/channels/${ENG}/threads/2026/09/${thread(ENG)}/thread.md`
    const opsThread = `slack/channels/${OPS}/threads/2026/09/${thread(OPS)}/thread.md`
    expect(paths(engWorkspace)).toEqual([
      `slack/channels/${ENG}/index.md`,
      engThread,
    ])
    expect(paths(bothWorkspace)).toEqual([
      `slack/channels/${ENG}/index.md`,
      engThread,
      `slack/channels/${OPS}/index.md`,
      opsThread,
    ])
    expect(count("conversations.history")).toBe(2)
    expect(count("conversations.replies")).toBe(2)
    const md = writes
      .get(engWorkspace)
      ?.files.find((file) => file.path === engThread)?.content
    expect(md).toContain(`Root of ${ENG}`)
    expect(md).not.toContain("ctx| agent working")
    expect(md).not.toContain("captured_at")
    // A patch: the files of other threads stay.
    expect(writes.get(engWorkspace)?.deletePaths).toEqual([])
  })

  it("does not read again a thread that each Workspace has", async () => {
    const first = await sync()
    const blobs = (workspaceId: string) =>
      (first.writes.get(workspaceId)?.files ?? []).map((file) => ({
        path: file.path,
        sha: gitBlobSha(Buffer.from(file.content)),
      }))
    calls = []
    const second = await sync({
      readExisting: async (workspaceId) => blobs(workspaceId),
    })
    expect(count("conversations.history")).toBe(2)
    expect(count("conversations.replies")).toBe(0)
    expect(second.writes.size).toBe(0)
  })

  it("reads only the thread of a webhook event, for the Workspaces of its channel", async () => {
    const { paths } = await sync({
      event: { channelId: OPS, threadTs: thread(OPS) },
    })
    expect(paths(engWorkspace)).toEqual([])
    expect(paths(bothWorkspace)).toEqual([
      `slack/channels/${OPS}/index.md`,
      `slack/channels/${OPS}/threads/2026/09/${thread(OPS)}/thread.md`,
    ])
    expect(count("conversations.history")).toBe(0)
    expect(
      calls
        .filter((call) => call.method === "conversations.replies")
        .map((call) => call.query.channel),
    ).toEqual([OPS])
  })

  it("marks only the source of a channel that the bot left, and keeps its files", async () => {
    failures[`conversations.info:${OPS}`] = "channel_not_found"
    const { paths, writes } = await sync()
    expect(paths(engWorkspace)).toHaveLength(2)
    expect(await status(engWorkspace)).toMatchObject({ status: "ok" })
    expect(await status(bothWorkspace)).toMatchObject({
      status: "out_of_access",
      statusDetail: expect.stringContaining(OPS),
    })
    expect(writes.get(bothWorkspace)?.keepPrefixes).toContain(
      `slack/channels/${OPS}/`,
    )
  })

  it("marks an archived channel invalid", async () => {
    channelState[OPS] = { is_archived: true }
    await sync()
    expect(await status(bothWorkspace)).toMatchObject({
      status: "invalid",
      statusDetail: "Channel #ops is archived",
    })
    expect(await status(engWorkspace)).toMatchObject({ status: "ok" })
  })

  it("skips a channel with a transient failure and deletes nothing", async () => {
    failures[`conversations.history:${OPS}`] = 503
    const { paths, writes } = await sync()
    expect(paths(bothWorkspace)).toContain(
      `slack/channels/${ENG}/threads/2026/09/${thread(ENG)}/thread.md`,
    )
    expect(
      paths(bothWorkspace).some(
        (path) => path.includes("/threads/") && path.includes(OPS),
      ),
    ).toBe(false)
    expect(writes.get(bothWorkspace)?.deletePaths).toEqual([])
    expect(await status(bothWorkspace)).toMatchObject({ status: "ok" })
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
    ).toBe("Invite the ctx| bot to channel #ops")
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
