import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq, inArray } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { setOrganizations } from "../auth/oauth-grants.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import {
  members,
  oauthAccessTokens,
  oauthClients,
  organizations,
} from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { listLinkedRepositoryPins } from "../models/workspace-source-state.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { withTestRequestLogger } from "../test/hono-test-logger.js"
import {
  insertLinkedRepositoryRows,
  insertProjectedSourceRows,
} from "../test/workspace-links-fixture.js"
import { mcpOrgSlugHash } from "./correlation.js"
import { fitPage } from "./framework/budget.js"
import {
  loadOrgRepositoryHandles,
  requireServed,
  resolveCallWorkspace,
} from "./framework/call-workspace.js"
import { decodeCursor, encodeCursor } from "./framework/cursor.js"
import {
  INSTRUCTIONS_HEAD_CHARS,
  INSTRUCTIONS_MAX_CHARS,
  loadServerInstructions,
} from "./framework/instructions.js"
import {
  defineMcpReadTool,
  READ_TOOL_ANNOTATIONS,
  registerMcpReadTools,
} from "./framework/tool-registry.js"
import { TOOL_ERROR_META_KEY } from "./framework/tool-result.js"

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const sha1 = "a".repeat(40)
const sha2 = "b".repeat(40)

const spans = recordSpans()
let seed: SeededOrg
const otherOrgs = [
  { id: `org_fw_other_a_${suffix}`, slug: `fw-other-a-${suffix}` },
  { id: `org_fw_other_b_${suffix}`, slug: `fw-other-b-${suffix}` },
  { id: `org_fw_other_d_${suffix}`, slug: `fw-other-d-${suffix}` },
]
const readyWorkspaceId = generateObjectId("ws")

let gate: { opened: Promise<void>; open: () => void } = newGate()
function newGate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

const servedSchema = z.object({ branch: z.string(), sha: z.string() })

const describeWorkspace = defineMcpReadTool({
  name: "probe_workspace",
  title: "Probe Workspace",
  description: "Test tool: resolve one Workspace of the org.",
  org: "required",
  alwaysLoad: true,
  inputShape: { workspace: z.string() },
  outputSchema: z.object({
    org: z.string(),
    workspace: z.string(),
    served: servedSchema,
  }),
  async run({ workspace }, { org }) {
    const resolved = await resolveCallWorkspace(org, workspace)
    return {
      org: org.slug,
      workspace: resolved.slug,
      served: requireServed(resolved),
    }
  },
})

const probeRepositories = defineMcpReadTool({
  name: "probe_repositories",
  title: "Probe repositories",
  description: "Test tool: list repository handles after exclusion.",
  org: "required",
  inputShape: { excludeRepositories: z.array(z.string()) },
  outputSchema: z.object({
    repositories: z.array(z.string()),
    excluded: z.array(z.string()),
  }),
  async run({ excludeRepositories }, { org }) {
    const handles = await loadOrgRepositoryHandles(org)
    const exclusion = handles.exclusion(excludeRepositories)
    return {
      repositories: handles
        .list()
        .filter((repository) => !exclusion.isExcluded(repository.url))
        .map((repository) => repository.handle),
      excluded: exclusion.excluded,
    }
  },
})

const ITEMS = Array.from({ length: 7 }, (_, index) => `item-${index}`)
const probePage = defineMcpReadTool({
  name: "probe_page",
  title: "Probe page",
  description: "Test tool: page a fixed list with a cursor bound to the SHA.",
  org: "required",
  inputShape: { workspace: z.string(), cursor: z.string().optional() },
  outputSchema: z.object({
    items: z.array(z.string()),
    cursor: z.string().optional(),
  }),
  async run({ workspace, cursor }, { org }) {
    const resolved = await resolveCallWorkspace(org, workspace)
    const binding = {
      orgId: org.id,
      workspaceId: resolved.id,
      sha: requireServed(resolved).sha,
      scope: "probe_page",
    }
    const offset = cursor ? decodeCursor(cursor, binding) : 0
    const page = fitPage(ITEMS, {
      offset,
      limit: 3,
      maxTokens: 4_000,
      result: (fitted) => ({ items: fitted }),
    })
    return {
      items: page.page,
      ...(page.nextOffset === null
        ? {}
        : {
            cursor: encodeCursor({ ...binding, offset: page.nextOffset }),
          }),
    }
  },
})

const probeWait = defineMcpReadTool({
  name: "probe_wait",
  title: "Probe wait",
  description: "Test tool: wait for the test gate.",
  org: "required",
  inputShape: {},
  outputSchema: z.object({ done: z.boolean() }),
  async run() {
    await gate.opened
    return { done: true }
  },
})

const probeCrash = defineMcpReadTool({
  name: "probe_crash",
  title: "Probe crash",
  description: "Test tool: throw an unexpected error.",
  org: "optional",
  inputShape: {},
  outputSchema: z.object({ done: z.boolean() }),
  async run() {
    throw new Error("database password=hunter2 leaked")
  },
})

const TOOLS = [
  describeWorkspace,
  probeRepositories,
  probePage,
  probeWait,
  probeCrash,
]

/** `shippedTools`: mount the tools, resources, and instructions that ship. */
function createApp({ shippedTools = false } = {}) {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env as Record<string, string | undefined>))
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  if (shippedTools) registerMcpRoutes(app)
  else
    registerMcpRoutes(app, {
      registerTools: (server: McpServer) => registerMcpReadTools(server, TOOLS),
      instructions: loadServerInstructions,
    })
  return app
}

/** `credential`: an `x-api-key` value, or the request headers to send. */
async function connect(
  credential: string | Record<string, string> = seed.orgApiKey,
  path = "/mcp",
  shippedTools = false,
): Promise<Client> {
  const app = createApp({ shippedTools })
  const client = new Client({ name: "framework-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: {
        headers:
          typeof credential === "string"
            ? { "x-api-key": credential }
            : credential,
      },
    }),
  )
  // Real clients list the tools first. Then the SDK Client checks each
  // result against the output schema of the tool.
  await client.listTools()
  return client
}

type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: Array<{ type: string; text?: string }>
  _meta?: Record<string, unknown>
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

/** The `{ code, message, retryable }` of a failed call. */
function failure(result: ToolResult): Record<string, unknown> | undefined {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
  return result._meta?.[TOOL_ERROR_META_KEY] as
    | Record<string, unknown>
    | undefined
}

describe("MCP tool framework (Postgres + MCP SDK Client)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await getSystemDb()
      .insert(organizations)
      .values(
        otherOrgs.map((org) => ({
          id: org.id,
          name: org.slug,
          slug: org.slug,
          createdAt: new Date(),
        })),
      )
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values([
        {
          id: readyWorkspaceId,
          orgId: seed.orgId,
          slug: "payments",
          displayName: "Payments",
          workspaceRepositoryUrl: `/tmp/fw-${suffix}-payments`,
          desiredDefaultBranch: "main",
          activeProjectionSha: sha1,
        },
        {
          id: generateObjectId("ws"),
          orgId: seed.orgId,
          slug: "platform",
          displayName: "Platform",
          workspaceRepositoryUrl: `/tmp/fw-${suffix}-platform`,
          desiredDefaultBranch: "main",
        },
      ])
      await insertLinkedRepositoryRows(
        db,
        [
          "https://github.com/example/payments-api",
          "git@github.com:example/ledger.git",
          "https://gitlab.example.com/example/ledger.git",
        ].map((gitUrl) => ({
          id: generateObjectId("wlr"),
          orgId: seed.orgId,
          workspaceId: readyWorkspaceId,
          gitUrl,
        })),
      )
      // ADR-050: GitHub sources in .ctxpipe/sources.yaml link repositories
      // too. Only an `ok` source serves its repositories.
      await insertProjectedSourceRows(db, [
        {
          id: generateObjectId("wsrc"),
          orgId: seed.orgId,
          workspaceId: readyWorkspaceId,
          sourceKey: "github",
          provider: "github",
          scope: {
            repositories: ["example/sourced-api", "Example/Payments-API"],
          },
          status: "ok",
          revision: sha1,
        },
        {
          id: generateObjectId("wsrc"),
          orgId: seed.orgId,
          workspaceId: readyWorkspaceId,
          sourceKey: "github-broken",
          provider: "github",
          scope: { repositories: ["example/broken"] },
          status: "out_of_access",
          revision: sha1,
        },
      ])
    })
    // The user is a member of orgs B and D (otherOrgs[1] and [2]) but not
    // of otherOrgs[0].
    await getSystemDb()
      .insert(members)
      .values(
        [otherOrgs[1], otherOrgs[2]].map((org, index) => ({
          id: `mem_fw_${index}_${suffix}`,
          organizationId: org?.id ?? "",
          userId: seed.userId,
          role: "member",
          createdAt: new Date(),
        })),
      )
    await withOrgDbContext(otherOrgs[1]?.id ?? "", (db) =>
      db.insert(workspaces).values({
        id: generateObjectId("ws"),
        orgId: otherOrgs[1]?.id ?? "",
        slug: "operations",
        displayName: "Operations",
        workspaceRepositoryUrl: `/tmp/fw-${suffix}-operations`,
        desiredDefaultBranch: "main",
        activeProjectionSha: sha2,
      }),
    )
    // A Workspace with a slug that only another org has.
    await withOrgDbContext(otherOrgs[0]?.id ?? "", (db) =>
      db.insert(workspaces).values({
        id: generateObjectId("ws"),
        orgId: otherOrgs[0]?.id ?? "",
        slug: "secret-plans",
        displayName: "Secret plans",
        workspaceRepositoryUrl: `/tmp/fw-${suffix}-secret`,
        desiredDefaultBranch: "main",
        activeProjectionSha: sha1,
      }),
    )
  })

  afterAll(async () => {
    if (!seed) return
    for (const org of [{ id: seed.orgId }, ...otherOrgs]) {
      await withOrgDbContext(org.id, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, org.id)),
      )
    }
    await getSystemDb()
      .delete(organizations)
      .where(
        inArray(
          organizations.id,
          otherOrgs.map((org) => org.id),
        ),
      )
    await cleanupSeededOrg(seed)
  })

  it("sends dynamic instructions on initialize: rules first, then the org and its Workspace slugs", async () => {
    const client = await connect()
    const instructions = client.getInstructions() ?? ""
    expect(instructions.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    expect(instructions.slice(0, INSTRUCTIONS_HEAD_CHARS)).toContain(
      "ctxpipe serves the default branch; do not use it for your current repository",
    )
    expect(instructions).toContain(`\n- ${seed.orgSlug}: payments, platform`)
    expect(instructions).not.toContain(otherOrgs[0]?.slug)
    expect(instructions).not.toContain("secret-plans")
    await client.close()
  })

  it("answers server/discover from a 2026-07-28 client with no initialize, in the spec shape", async () => {
    const client = await connect()
    const response = await createApp().request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "x-api-key": seed.orgApiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-1",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "ExampleClient",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      jsonrpc: string
      id: string
      result: Record<string, unknown>
    }
    expect(body).toMatchObject({ jsonrpc: "2.0", id: "discover-1" })
    expect(body.result).toEqual({
      resultType: "complete",
      supportedVersions: expect.arrayContaining(["2025-11-25"]),
      // The same capabilities as initialize. This fails when the SDK
      // changes how it reports capabilities.
      capabilities: client.getServerCapabilities(),
      _meta: {
        "io.modelcontextprotocol/serverInfo": expect.objectContaining({
          name: "ctxpipe",
          version: expect.any(String),
        }),
      },
      instructions: client.getInstructions(),
    })
    await client.close()
  })

  it("keeps instructions under 2,048 characters with 50 Workspaces in 3 orgs, through the SDK Client", async () => {
    // The personal key reaches orgs A, B and D. Realistic slug lengths.
    const orgs = [
      { id: seed.orgId, slug: seed.orgSlug },
      otherOrgs[1],
      otherOrgs[2],
    ].filter((org): org is { id: string; slug: string } => Boolean(org))
    const areas = ["payments", "identity", "search", "platform", "analytics"]
    const counts = [16, 17, 17]
    const created: string[] = []
    for (const [index, org] of orgs.entries()) {
      const rows = Array.from({ length: counts[index] ?? 0 }, (_, n) => {
        const id = generateObjectId("ws")
        created.push(id)
        return {
          id,
          orgId: org.id,
          slug: `${areas[n % areas.length]}-service-team-${index}-${n}`,
          displayName: `Team ${n}`,
          workspaceRepositoryUrl: `/tmp/fw-${suffix}-${index}-${n}`,
        }
      })
      await withOrgDbContext(org.id, (db) => db.insert(workspaces).values(rows))
    }
    try {
      const client = await connect(seed.personalApiKey)
      const instructions = client.getInstructions() ?? ""
      await client.close()
      expect(instructions.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
      for (const org of orgs) expect(instructions).toContain(`\n- ${org.slug}:`)
      expect(instructions).not.toContain(otherOrgs[0]?.slug ?? "")
      // 50 new Workspaces + payments, platform and operations.
      const shown = (instructions.match(/-service-team-\d+-\d+/g) ?? []).length
      const more = Number(
        instructions.match(/\[and (\d+) more Workspaces/)?.[1] ?? 0,
      )
      expect(shown + 3 + more).toBe(53)
      // Each org shows Workspaces, so a large org hides no other org.
      for (const index of [0, 1, 2]) {
        expect(instructions).toContain(`-service-team-${index}-0`)
      }
    } finally {
      for (const org of orgs) {
        await withOrgDbContext(org.id, (db) =>
          db.delete(workspaces).where(inArray(workspaces.id, created)),
        )
      }
    }
  })

  it("lists the tools in a stable order with title, annotations, schemas, and alwaysLoad", async () => {
    const first = await connect()
    const second = await connect()
    const [a, b] = await Promise.all([first.listTools(), second.listTools()])
    expect(a.tools.map((tool) => tool.name)).toEqual(
      TOOLS.map((tool) => tool.name),
    )
    expect(b.tools.map((tool) => tool.name)).toEqual(
      a.tools.map((tool) => tool.name),
    )
    const [probe] = a.tools
    expect(probe?.title).toBe("Probe Workspace")
    expect(probe?.annotations).toEqual(READ_TOOL_ANNOTATIONS)
    expect(probe?._meta).toEqual({ "anthropic/alwaysLoad": true })
    expect(Object.keys(probe?.inputSchema.properties ?? {})).toEqual([
      "org",
      "workspace",
    ])
    expect(probe?.inputSchema.required).toEqual(["org", "workspace"])
    expect(probe?.outputSchema?.properties).toHaveProperty("served")
    expect(a.tools[1]?._meta).toBeUndefined()
    expect(
      a.tools.find((tool) => tool.name === "probe_crash")?.inputSchema.required,
    ).toBeUndefined()
    await Promise.all([first.close(), second.close()])
  })

  it("resolves org and Workspace slugs and returns structuredContent with TOON text", async () => {
    const client = await connect()
    const result = await call(client, "probe_workspace", {
      org: seed.orgSlug.toUpperCase(),
      workspace: "Payments",
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      org: seed.orgSlug,
      workspace: "payments",
      served: { branch: "main", sha: sha1 },
    })
    // P1-4 correlation runs for each framework tool call.
    expect(result._meta?.["ai.ctxpipe/callId"]).toMatch(/^call_/)
    expect(result.content?.[0]?.text).toBe(
      `org: ${seed.orgSlug}\nworkspace: payments\nserved:\n  branch: main\n  sha: ${sha1}`,
    )
    await client.close()
  })

  it("gives the same org_not_found for an unknown org and an org outside the connection", async () => {
    const client = await connect()
    const foreign = await call(client, "probe_workspace", {
      org: otherOrgs[0]?.slug,
      workspace: "secret-plans",
    })
    const unknown = await call(client, "probe_workspace", {
      org: `no-such-org-${suffix}`,
      workspace: "secret-plans",
    })
    expect(failure(foreign)).toMatchObject({
      code: "org_not_found",
      retryable: false,
    })
    const normalize = (text: string | undefined) =>
      text
        ?.replace(otherOrgs[0]?.slug ?? "", "<org>")
        .replace(`no-such-org-${suffix}`, "<org>")
    expect(normalize(foreign.content?.[0]?.text)).toBe(
      normalize(unknown.content?.[0]?.text),
    )
    await client.close()
  })

  it("gives the same workspace_not_found for an unknown Workspace and a Workspace of another org", async () => {
    const client = await connect()
    const foreign = await call(client, "probe_workspace", {
      org: seed.orgSlug,
      workspace: "secret-plans",
    })
    const unknown = await call(client, "probe_workspace", {
      org: seed.orgSlug,
      workspace: "no-such-workspace",
    })
    expect(failure(foreign)).toMatchObject({
      code: "workspace_not_found",
    })
    expect(foreign.content?.[0]?.text?.replace("secret-plans", "<ws>")).toBe(
      unknown.content?.[0]?.text?.replace("no-such-workspace", "<ws>"),
    )
    await client.close()
  })

  it("gives retryable workspace_not_ready before the first projection", async () => {
    const client = await connect()
    const result = await call(client, "probe_workspace", {
      org: seed.orgSlug,
      workspace: "platform",
    })
    expect(failure(result)).toMatchObject({
      code: "workspace_not_ready",
      retryable: true,
    })
    await client.close()
  })

  it.each([
    ["handle", "example/payments-api"],
    ["HTTPS", "https://github.com/example/payments-api"],
    ["HTTPS with .git", "https://github.com/example/payments-api.git"],
    ["SSH", "git@github.com:example/payments-api.git"],
  ])("excludes the same repository by %s", async (_form, input) => {
    const client = await connect()
    const result = await call(client, "probe_repositories", {
      org: seed.orgSlug,
      excludeRepositories: [input],
    })
    expect(result.structuredContent).toEqual({
      repositories: [
        "github.com/example/ledger",
        "gitlab.example.com/example/ledger",
        "example/sourced-api",
      ],
      excluded: ["example/payments-api"],
    })
    await client.close()
  })

  it("hides the repository of an out_of_access source and keeps its pins", async () => {
    const client = await connect()
    try {
      const result = await call(client, "probe_repositories", {
        org: seed.orgSlug,
        excludeRepositories: [],
      })
      expect(result.structuredContent?.repositories).not.toContain(
        "example/broken",
      )
    } finally {
      await client.close()
    }
    // The pins stay, so the link keeps its id and SHAs when access returns.
    const pins = await withOrgDbContext(seed.orgId, (db) =>
      listLinkedRepositoryPins(db, { workspaceId: readyWorkspaceId }),
    )
    expect(pins.map((pin) => pin.gitUrl)).toContain(
      "https://github.com/example/broken",
    )
  })

  it("walks a cursor and gives stale_cursor after a new projection", async () => {
    const client = await connect()
    const seen: string[] = []
    let cursor: string | undefined
    const first = await call(client, "probe_page", {
      org: seed.orgSlug,
      workspace: "payments",
    })
    seen.push(...((first.structuredContent?.items as string[]) ?? []))
    cursor = first.structuredContent?.cursor as string | undefined
    const second = await call(client, "probe_page", {
      org: seed.orgSlug,
      workspace: "payments",
      cursor,
    })
    seen.push(...((second.structuredContent?.items as string[]) ?? []))
    cursor = second.structuredContent?.cursor as string | undefined
    expect(seen).toEqual(ITEMS.slice(0, 6))
    expect(cursor).toBeDefined()

    const other = await call(client, "probe_page", {
      org: seed.orgSlug,
      workspace: "platform",
      cursor,
    })
    expect(failure(other)).toMatchObject({
      code: "workspace_not_ready",
    })

    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaces)
        .set({ activeProjectionSha: sha2 })
        .where(eq(workspaces.id, readyWorkspaceId)),
    )
    try {
      const stale = await call(client, "probe_page", {
        org: seed.orgSlug,
        workspace: "payments",
        cursor,
      })
      expect(failure(stale)).toMatchObject({
        code: "stale_cursor",
        retryable: false,
      })
    } finally {
      await withOrgDbContext(seed.orgId, (db) =>
        db
          .update(workspaces)
          .set({ activeProjectionSha: sha1 })
          .where(eq(workspaces.id, readyWorkspaceId)),
      )
    }
    await client.close()
  })

  it("allows 8 parallel calls for one principal and refuses the ninth", async () => {
    gate = newGate()
    const client = await connect()
    const running = Array.from({ length: 8 }, () =>
      call(client, "probe_wait", { org: seed.orgSlug }),
    )
    // Let the eight calls reach the tool before the ninth.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const ninth = await call(client, "probe_wait", { org: seed.orgSlug })
    expect(failure(ninth)).toMatchObject({
      code: "too_many_requests",
      retryable: true,
    })
    gate.open()
    const results = await Promise.all(running)
    expect(results.every((result) => !result.isError)).toBe(true)
    const after = await call(client, "probe_wait", { org: seed.orgSlug })
    expect(after.structuredContent).toEqual({ done: true })
    await client.close()
  })

  it("takes the org of a call from the org argument, not from ?orgSlug= on the URL", async () => {
    const orgB = otherOrgs[1]?.slug ?? ""
    const client = await connect(
      seed.personalApiKey,
      `/mcp?orgSlug=${seed.orgSlug}`,
    )
    const inB = await call(client, "probe_workspace", {
      org: orgB,
      workspace: "operations",
    })
    expect(inB.structuredContent).toEqual({
      org: orgB,
      workspace: "operations",
      served: { branch: "main", sha: sha2 },
    })
    // The URL org does not leak into a call that names another org.
    const notInB = await call(client, "probe_workspace", {
      org: orgB,
      workspace: "payments",
    })
    expect(failure(notInB)).toMatchObject({ code: "workspace_not_found" })
    const inA = await call(client, "probe_workspace", {
      org: seed.orgSlug,
      workspace: "payments",
    })
    expect(inA.structuredContent).toMatchObject({ org: seed.orgSlug })
    await client.close()
  })

  it("gives org_not_found to a user principal for an org outside its set, with the same text as an unknown org", async () => {
    const client = await connect(
      seed.personalApiKey,
      `/mcp?orgSlug=${seed.orgSlug}`,
    )
    const foreignSlug = otherOrgs[0]?.slug ?? ""
    const foreign = await call(client, "probe_workspace", {
      org: foreignSlug,
      workspace: "secret-plans",
    })
    const unknown = await call(client, "probe_workspace", {
      org: `missing-${suffix}`,
      workspace: "secret-plans",
    })
    expect(failure(foreign)).toMatchObject({ code: "org_not_found" })
    expect(foreign.content?.[0]?.text?.replace(foreignSlug, "<org>")).toBe(
      unknown.content?.[0]?.text?.replace(`missing-${suffix}`, "<org>"),
    )
    await client.close()
  })

  it("points an OAuth connection to Connected apps on org_not_found, with the same text for an unknown org", async () => {
    const clientId = `client_fw_${suffix}`
    const grantId = generateObjectId("ogr")
    const token = `opaque_${generateObjectId("tok")}`
    const db = getSystemDb()
    await db.insert(oauthClients).values({
      id: generateObjectId("oac"),
      clientId,
      redirectUris: ["http://localhost/callback"],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    try {
      await setOrganizations({ grantId }, [seed.orgId])
      await db.insert(oauthAccessTokens).values({
        id: generateObjectId("oat"),
        token: createHash("sha256").update(token).digest("base64url"),
        clientId,
        userId: seed.userId,
        referenceId: grantId,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
        scopes: ["ctxpipe:read"],
      })
      const client = await connect({ authorization: `Bearer ${token}` })
      // The seed user is a member of otherOrgs[1], but the grant leaves it out.
      const outside = await call(client, "probe_workspace", {
        org: otherOrgs[1]?.slug,
        workspace: "operations",
      })
      const unknown = await call(client, "probe_workspace", {
        org: `no-such-org-${suffix}`,
        workspace: "operations",
      })
      expect(failure(outside)).toMatchObject({ code: "org_not_found" })
      const text = outside.content?.[0]?.text ?? ""
      expect(text).toContain("Connected apps")
      expect(text).toContain("/.auth/account/connected-apps")
      expect(text.replace(otherOrgs[1]?.slug ?? "", "<org>")).toBe(
        unknown.content?.[0]?.text?.replace(`no-such-org-${suffix}`, "<org>"),
      )
      await client.close()

      // An API key is not an OAuth connection: no Connected apps hint.
      const keyClient = await connect()
      const keyResult = await call(keyClient, "probe_workspace", {
        org: `no-such-org-${suffix}`,
        workspace: "operations",
      })
      expect(keyResult.content?.[0]?.text).not.toContain("Connected apps")
      await keyClient.close()
    } finally {
      await db
        .delete(oauthGrantOrganizations)
        .where(eq(oauthGrantOrganizations.grantId, grantId))
      await db.delete(oauthClients).where(eq(oauthClients.clientId, clientId))
    }
  })

  it("serves a principal with several orgs on the bare /mcp URL: instructions list each org, calls name one", async () => {
    const client = await connect(seed.personalApiKey)
    const instructions = client.getInstructions() ?? ""
    expect(instructions).toContain(`\n- ${seed.orgSlug}: payments, platform`)
    expect(instructions).toContain(`\n- ${otherOrgs[1]?.slug}: operations`)
    expect(instructions).not.toContain(otherOrgs[0]?.slug ?? "")
    const result = await call(client, "probe_workspace", {
      org: otherOrgs[1]?.slug,
      workspace: "operations",
    })
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  it.each([
    ["an org outside the connection", () => otherOrgs[0]?.slug ?? ""],
    ["an unknown org", () => `no-such-org-${suffix}`],
    ["a slug with bad characters", () => "bad%0Aslug"],
  ])("accepts and ignores a ?orgSlug= for %s: tools/list and calls that name an allowed org work", async (_case, slug) => {
    const client = await connect(seed.personalApiKey, `/mcp?orgSlug=${slug()}`)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("probe_workspace")
    const result = await call(client, "probe_workspace", {
      org: otherOrgs[1]?.slug,
      workspace: "operations",
    })
    expect(result.structuredContent).toMatchObject({
      org: otherOrgs[1]?.slug,
    })
    await client.close()
  })

  it("puts the org of the call on the tool span, not the ?orgSlug= default", async () => {
    const client = await connect(
      seed.personalApiKey,
      `/mcp?orgSlug=${seed.orgSlug}`,
    )
    spans.reset()
    await call(client, "probe_workspace", {
      org: otherOrgs[1]?.slug,
      workspace: "operations",
    })
    const span = spans.spanNamed("mcp.tool probe_workspace")
    expect(span).toBeDefined()
    expect(spans.attributes(span)).toMatchObject({
      "ctxpipe.org.id": otherOrgs[1]?.id,
      "ctxpipe.org.slug": otherOrgs[1]?.slug,
      "ctxpipe.mcp.org.slug_hash": mcpOrgSlugHash(otherOrgs[1]?.slug ?? ""),
    })
    await client.close()
  })

  it("adds a call id to a failed framework tool call too", async () => {
    const client = await connect()
    const failed = await call(client, "probe_workspace", {
      org: `missing-${suffix}`,
      workspace: "payments",
    })
    expect(failure(failed)).toMatchObject({ code: "org_not_found" })
    expect(failed._meta?.["ai.ctxpipe/callId"]).toMatch(/^call_/)
    await client.close()
  })

  it("ships the seven read tools, the workspace-file template, and instructions, and no ctx_advisor", async () => {
    const client = await connect(seed.orgApiKey, "/mcp", true)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_workspaces",
      "search_knowledge",
      "search_code",
      "find_symbol",
      "read_file",
      "list_files",
      "get_related",
    ])
    for (const tool of tools) {
      expect(tool.annotations).toEqual(READ_TOOL_ANNOTATIONS)
    }
    const { resourceTemplates } = await client.listResourceTemplates()
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "ctxpipe://{org}/{workspace}/{+ref}",
    ])
    expect(client.getInstructions()).toContain(seed.orgSlug)
    await client.close()
  })

  it("maps an unexpected error to a retryable internal error with no detail", async () => {
    const client = await connect()
    const result = await call(client, "probe_crash", {})
    expect(failure(result)).toEqual({
      code: "internal",
      message: "ctxpipe could not complete the call. Try again.",
      retryable: true,
    })
    expect(JSON.stringify(result)).not.toContain("hunter2")
    await client.close()
  })
})
