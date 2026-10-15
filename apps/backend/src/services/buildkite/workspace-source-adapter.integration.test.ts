import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import {
  syncConnectionSources,
  type WorkspaceSliceWrite,
} from "../../domain/workspace-sources/sync.js"
import { buildkiteConnectionConfigStoredSchema } from "../../lib/connection-config.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import {
  listWorkspaceSourceRows,
  replaceWorkspaceSourceRows,
} from "../../models/workspace-sources.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  BUILDKITE_SYNC_MAX_TRIES,
  buildkiteSourceAdapter,
} from "./workspace-source-adapter.js"

const API = "https://api.buildkite.com/v2/organizations/acme/pipelines"

/** The Buildkite organization that msw serves: build numbers by pipeline. */
const bk = {
  builds: new Map<string, number[]>([
    ["web-app", [12, 11]],
    ["deploy", [3]],
  ]),
  /** A status for a pipeline read, for example 404 or 503. */
  pipelineStatus: new Map<string, number>(),
  unauthorized: false,
  reads: [] as string[],
}

const unauthorized = () =>
  bk.unauthorized
    ? HttpResponse.json({ message: "Unauthorized" }, { status: 401 })
    : undefined

const server = setupServer(
  http.get(`${API}/:slug`, ({ params }) => {
    const slug = String(params.slug)
    bk.reads.push(`pipeline:${slug}`)
    const status = bk.pipelineStatus.get(slug)
    return (
      unauthorized() ??
      (status
        ? HttpResponse.json({ message: "failed" }, { status })
        : HttpResponse.json({
            id: `id-${slug}`,
            slug,
            name: slug,
            web_url: `https://buildkite.com/acme/${slug}`,
            repository: `git@github.com:acme/${slug}.git`,
            default_branch: "main",
          }))
    )
  }),
  http.get(`${API}/:slug/builds`, ({ params, request }) => {
    const slug = String(params.slug)
    bk.reads.push(`builds:${slug}`)
    expect(new URL(request.url).searchParams.get("state")).toBe("finished")
    return (
      unauthorized() ??
      HttpResponse.json(
        (bk.builds.get(slug) ?? []).map((number) => ({
          id: `build-${slug}-${number}`,
          number,
          web_url: `https://buildkite.com/acme/${slug}/builds/${number}`,
          state: "passed",
          branch: "main",
          commit: "abc1234def5678",
          message: `Build ${number}`,
          env: { DEPLOY_TOKEN: "do-not-mirror" },
          jobs: [
            {
              type: "script",
              name: "Tests",
              state: "passed",
              exit_status: 0,
              command: "DEPLOY_TOKEN=do-not-mirror make test",
            },
          ],
        })),
      )
    )
  }),
)

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const installed = () => ({
  organizationSlug: "acme",
  apiTokenEnc: encryptConnectionSecret("fixture-api-token", env),
  status: "installed",
})

async function addSource(
  connectionId: string,
  slug: string,
  pipelines: string[],
) {
  const workspaceId = await seed.addWorkspace(slug)
  await replaceWorkspaceSourceRows({
    orgId: seed.orgId,
    workspaceId,
    revision: "a".repeat(40),
    rows: [
      {
        sourceKey: slug,
        provider: "buildkite",
        connectionId,
        scope: { pipelines },
        status: "ok",
        statusDetail: null,
      },
    ],
  })
  return workspaceId
}

async function sync(
  connectionId: string,
  blobs?: Array<{ path: string; sha: string }>,
) {
  const writes: WorkspaceSliceWrite[] = []
  await withLogger(createLogger({ test: "buildkite-sources" }), () =>
    syncConnectionSources({
      orgId: seed.orgId,
      connectionId,
      env,
      adapter: buildkiteSourceAdapter,
      readExisting: blobs ? async () => blobs : undefined,
      write: async (write) => {
        writes.push(write)
      },
    }),
  )
  return new Map(writes.map((write) => [write.workspaceId, write]))
}

const paths = (write: WorkspaceSliceWrite | undefined) =>
  (write?.files ?? []).map((file) => file.path).sort()

const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex")

async function storedConfig(connectionId: string) {
  const [row] = await withOrgDbContext(seed.orgId, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(eq(connections.id, connectionId)),
  )
  return buildkiteConnectionConfigStoredSchema.parse(row?.config)
}

describe("Buildkite source adapter (Postgres + msw)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" })
    seed = await seedSourcesOrg("wsrc_buildkite")
    env = parseEnv(process.env)
  })
  afterEach(() => {
    vi.useRealTimers()
    bk.unauthorized = false
    bk.reads.length = 0
    bk.pipelineStatus.clear()
  })
  afterAll(async () => {
    server.close()
    await seed.cleanup()
  })

  it("reads each pipeline once and writes each Workspace only its pipelines", async () => {
    const connection = await seed.addConnection("buildkite", installed())
    const web = await addSource(connection, "bk-web", ["web-app"])
    const both = await addSource(connection, "bk-both", ["web-app", "deploy"])

    const writes = await sync(connection)

    expect(bk.reads.sort()).toEqual([
      "builds:deploy",
      "builds:web-app",
      "pipeline:deploy",
      "pipeline:web-app",
    ])
    expect(paths(writes.get(web))).toEqual([
      "buildkite/pipelines/web-app/builds/11.md",
      "buildkite/pipelines/web-app/builds/12.md",
      "buildkite/pipelines/web-app/pipeline.md",
    ])
    expect(paths(writes.get(both))).toHaveLength(5)
    const text = writes
      .get(web)
      ?.files.map((file) => file.content)
      .join("\n")
    expect(text).toContain("# web-app build #12")
    expect(text).not.toContain("do-not-mirror")
  })

  it("skips unchanged files and deletes the builds that rolled off", async () => {
    const connection = await seed.addConnection("buildkite", installed())
    const web = await addSource(connection, "bk-patch", ["web-app"])
    const first = (await sync(connection)).get(web)
    const kept = first?.files.find((file) => file.path.endsWith("/11.md"))
    const rolledOff = "buildkite/pipelines/web-app/builds/10.md"

    const write = (
      await sync(connection, [
        { path: kept?.path ?? "", sha: blobSha(kept?.content ?? "") },
        { path: rolledOff, sha: blobSha("old") },
      ])
    ).get(web)

    expect(paths(write)).toEqual([
      "buildkite/pipelines/web-app/builds/12.md",
      "buildkite/pipelines/web-app/pipeline.md",
    ])
    expect(write?.deletePaths).toEqual([rolledOff])
  })

  it("keeps a missing pipeline, counts only permanent failures, then marks its source", async () => {
    const connection = await seed.addConnection("buildkite", installed())
    const web = await addSource(connection, "bk-fail-web", ["web-app"])
    const mixed = await addSource(connection, "bk-fail-mixed", [
      "gone",
      "deploy",
    ])

    // An outage keeps the copy and does not count.
    bk.pipelineStatus.set("gone", 503)
    let writes = await sync(connection)
    expect(writes.get(mixed)?.keepPrefixes).toEqual([
      "buildkite/pipelines/gone/",
    ])
    expect((await storedConfig(connection)).sourceSync?.failures).toEqual({})

    bk.pipelineStatus.set("gone", 404)
    vi.useFakeTimers({ toFake: ["Date"] })
    for (let cycle = 1; cycle <= BUILDKITE_SYNC_MAX_TRIES; cycle += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, cycle * 2)))
      writes = await sync(connection)
      expect(paths(writes.get(web))).toHaveLength(3)
      expect(paths(writes.get(mixed))).toEqual([
        "buildkite/pipelines/deploy/builds/3.md",
        "buildkite/pipelines/deploy/pipeline.md",
      ])
    }

    const [row] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: mixed,
    })
    expect(row?.status).toBe("out_of_access")
    expect(row?.statusDetail).toContain(
      "Buildkite pipeline gone does not exist",
    )
    const [webRow] = await listWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId: web,
    })
    expect(webRow?.status).toBe("ok")
  })

  it("names a missing pipeline in the access check", async () => {
    const connection = await seed.addConnection("buildkite", installed())
    bk.pipelineStatus.set("gone", 404)
    bk.pipelineStatus.set("private", 403)

    expect(
      await buildkiteSourceAdapter.checkAccess?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { pipelines: ["web-app", "gone", "private"] },
        env,
      }),
    ).toBe(
      "Buildkite pipeline gone does not exist. Remove it from the source.; ctx| cannot read Buildkite pipeline private. Give the API access token access to it, or remove it from the source.",
    )
  })

  it("keeps every file and marks the connection revoked when Buildkite refuses its token", async () => {
    const connection = await seed.addConnection("buildkite", installed())
    const web = await addSource(connection, "bk-revoked", ["web-app"])
    bk.unauthorized = true

    const writes = await sync(connection)

    expect(writes.has(web)).toBe(false)
    expect((await storedConfig(connection)).status).toBe("revoked")
    expect(
      await buildkiteSourceAdapter.syncStatus?.({
        orgId: seed.orgId,
        connectionId: connection,
        scope: { pipelines: ["web-app"] },
      }),
    ).toEqual({
      status: "out_of_access",
      detail: expect.stringMatching(/Reconnect Buildkite/),
    })
    // A later sync does not call Buildkite with the refused token.
    bk.reads.length = 0
    await sync(connection)
    expect(bk.reads).toEqual([])
  })
})
