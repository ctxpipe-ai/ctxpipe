import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"
import { useMswServer } from "../../test/msw.js"
import {
  deletePreviewSandboxes,
  EVERY_PREVIEW,
} from "./deletePreviewSandboxes.js"

const API = "https://vercel.com/api/v2/sandboxes"
const credentials = {
  token: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
}

function sandbox(
  name: string,
  environment: string | null,
  kind:
    | "workspace-chat"
    | "workspace-base"
    | "workspace-agent" = "workspace-chat",
): {
  name: string
  persistent: boolean
  createdAt: number
  updatedAt: number
  currentSessionId: string
  status: string
  tags: Record<string, string>
} {
  return {
    name,
    persistent: true,
    createdAt: 1,
    updatedAt: 1,
    currentSessionId: `sess_${name}`,
    status: "stopped",
    tags:
      environment === null ? { ctxpipe: kind } : { ctxpipe: kind, environment },
  }
}

function session(name: string) {
  return {
    id: `sess_${name}`,
    memory: 2048,
    vcpus: 1,
    region: "iad1",
    runtime: "node24",
    timeout: 60_000,
    status: "stopped",
    requestedAt: 1,
    createdAt: 1,
    cwd: "/vercel/sandbox",
    updatedAt: 1,
  }
}

function snapshot(id: string, status = "created") {
  return {
    id,
    sourceSessionId: "sess_x",
    region: "iad1",
    status,
    sizeBytes: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * A Vercel project holding sandboxes and their saved snapshots. Deletes are
 * applied, so a second cleanup sees what the first one left. The sandbox
 * list returns `pageSize` sandboxes per page, with a cursor to the next page.
 */
function vercelProject(input: {
  sandboxes: ReturnType<typeof sandbox>[]
  snapshots: Record<string, ReturnType<typeof snapshot>[]>
  failDeleteWith?: number
  failDeleteOf?: string
  pageSize?: number
}) {
  const sandboxes = new Map(input.sandboxes.map((s) => [s.name, s]))
  const snapshots = new Map(
    Object.entries(input.snapshots).flatMap(([name, list]) =>
      list.map((s) => [s.id, { ...s, sandbox: name }] as const),
    ),
  )
  const requests: string[] = []
  const handlers = [
    http.get(`${API}/snapshots`, ({ request }) => {
      const url = new URL(request.url)
      requests.push(`list snapshots ${url.searchParams.get("name")}`)
      return HttpResponse.json({
        snapshots: [...snapshots.values()]
          .filter((s) => s.sandbox === url.searchParams.get("name"))
          .map(({ sandbox: _, ...s }) => s),
        pagination: { count: 0, next: null },
      })
    }),
    http.get(`${API}/snapshots/:id`, ({ params }) => {
      const found = snapshots.get(String(params.id))
      if (!found) return HttpResponse.json({}, { status: 404 })
      const { sandbox: _, ...s } = found
      return HttpResponse.json({ snapshot: s })
    }),
    http.delete(`${API}/snapshots/:id`, ({ params }) => {
      const found = snapshots.get(String(params.id))
      requests.push(`delete snapshot ${params.id}`)
      if (!found) return HttpResponse.json({}, { status: 404 })
      snapshots.delete(String(params.id))
      const { sandbox: _, ...s } = found
      return HttpResponse.json({ snapshot: { ...s, status: "deleted" } })
    }),
    http.get(API, ({ request }) => {
      const url = new URL(request.url)
      const cursor = url.searchParams.get("cursor")
      requests.push(
        `list sandboxes ${url.searchParams.get("project")} ${url.searchParams.getAll("tags").join(",")}${cursor ? ` cursor ${cursor}` : ""}`,
      )
      // The Vercel API filters on one tag only and rejects more.
      if (url.searchParams.getAll("tags").length > 1)
        return HttpResponse.json({}, { status: 400 })
      // Simulates a filter that returns too much: the cleanup must not trust it.
      const all = [...sandboxes.values()]
      const size = input.pageSize ?? Math.max(all.length, 1)
      const start = cursor ? Number(cursor) : 0
      const end = start + size
      return HttpResponse.json({
        sandboxes: all.slice(start, end),
        pagination: {
          count: all.length,
          next: end < all.length ? String(end) : null,
        },
      })
    }),
    http.get(`${API}/:name`, ({ params }) => {
      const found = sandboxes.get(String(params.name))
      if (!found) return HttpResponse.json({}, { status: 404 })
      return HttpResponse.json({
        sandbox: found,
        session: session(found.name),
        routes: [],
      })
    }),
    http.delete(`${API}/:name`, ({ params }) => {
      const found = sandboxes.get(String(params.name))
      requests.push(`delete sandbox ${params.name}`)
      if (
        input.failDeleteWith &&
        (!input.failDeleteOf || input.failDeleteOf === params.name)
      )
        return HttpResponse.json(
          { error: { message: "forbidden" } },
          { status: input.failDeleteWith },
        )
      if (!found) return HttpResponse.json({}, { status: 404 })
      sandboxes.delete(found.name)
      return HttpResponse.json({ sandbox: found })
    }),
  ]
  return { handlers, requests, sandboxes, snapshots }
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
const server = useMswServer()

describe("deletePreviewSandboxes", () => {
  it("deletes the preview's sandboxes and saved state, and leaves other environments alone", async () => {
    const project = vercelProject({
      sandboxes: [
        sandbox("chat-a", "pr-7"),
        sandbox("chat-b", "pr-7"),
        sandbox("chat-prod", "production"),
      ],
      snapshots: {
        "chat-a": [snapshot("snap_a1"), snapshot("snap_a0", "deleted")],
        "chat-b": [],
        "chat-prod": [snapshot("snap_prod")],
      },
    })
    server.use(...project.handlers)

    const deleted = await deletePreviewSandboxes({
      credentials,
      environment: "pr-7",
    })

    expect(deleted).toEqual(["chat-a", "chat-b"])
    expect(project.requests[0]).toBe("list sandboxes prj_test environment:pr-7")
    expect([...project.sandboxes.keys()]).toEqual(["chat-prod"])
    expect([...project.snapshots.keys()]).toEqual(["snap_a0", "snap_prod"])
    expect(project.requests).not.toContain("delete sandbox chat-prod")
  })

  it("deletes the preview's base and agent builders, their snapshots first", async () => {
    const project = vercelProject({
      sandboxes: [
        sandbox("chat-a", "pr-7"),
        sandbox("base-a", "pr-7", "workspace-base"),
        sandbox("agent-a", "pr-7", "workspace-agent"),
        sandbox("base-prod", "production", "workspace-base"),
      ],
      snapshots: {
        "chat-a": [],
        "base-a": [snapshot("snap_base_a")],
        "agent-a": [snapshot("snap_agent_a")],
        "base-prod": [snapshot("snap_base_prod")],
      },
    })
    server.use(...project.handlers)

    const deleted = await deletePreviewSandboxes({
      credentials,
      environment: "pr-7",
    })

    expect(deleted).toEqual(["chat-a", "base-a", "agent-a"])
    expect([...project.sandboxes.keys()]).toEqual(["base-prod"])
    expect([...project.snapshots.keys()]).toEqual(["snap_base_prod"])
    // A builder whose delete fails never leaves an unowned snapshot.
    expect(
      project.requests.indexOf("delete snapshot snap_base_a"),
    ).toBeLessThan(project.requests.indexOf("delete sandbox base-a"))
  })

  it("is idempotent: a second run finds nothing left to delete", async () => {
    const project = vercelProject({
      sandboxes: [sandbox("chat-a", "pr-7")],
      snapshots: { "chat-a": [snapshot("snap_a1")] },
    })
    server.use(...project.handlers)

    await deletePreviewSandboxes({ credentials, environment: "pr-7" })
    const again = await deletePreviewSandboxes({
      credentials,
      environment: "pr-7",
    })

    expect(again).toEqual([])
    expect(project.snapshots.size).toBe(0)
  })

  it("treats a sandbox or snapshot deleted in the meantime as deleted", async () => {
    const project = vercelProject({
      sandboxes: [sandbox("chat-a", "pr-7")],
      snapshots: { "chat-a": [snapshot("snap_a1")] },
    })
    server.use(
      // Listed, then gone: deleting the sandbox also removed its snapshot.
      http.get(`${API}/chat-a`, () => HttpResponse.json({}, { status: 404 })),
      http.get(`${API}/snapshots/snap_a1`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
      ...project.handlers,
    )

    await expect(
      deletePreviewSandboxes({ credentials, environment: "pr-7" }),
    ).resolves.toEqual(["chat-a"])
  })

  it("fails on any other API error", async () => {
    const project = vercelProject({
      sandboxes: [sandbox("chat-a", "pr-7")],
      snapshots: { "chat-a": [] },
      failDeleteWith: 403,
    })
    server.use(...project.handlers)

    await expect(
      deletePreviewSandboxes({ credentials, environment: "pr-7" }),
    ).rejects.toMatchObject({ response: { status: 403 } })
    expect([...project.sandboxes.keys()]).toEqual(["chat-a"])
  })

  it("deletes every preview's leftovers and keeps anything not tagged pr-<number>", async () => {
    const project = vercelProject({
      sandboxes: [
        sandbox("chat-12", "pr-12"),
        sandbox("base-12", "pr-12", "workspace-base"),
        sandbox("chat-prod", "production"),
        sandbox("base-prod", "production", "workspace-base"),
        sandbox("chat-abc", "pr-abc"),
        sandbox("chat-12x", "pr-12x"),
        sandbox("chat-untagged", null),
        sandbox("chat-local", "local-dev"),
      ],
      snapshots: {
        "chat-12": [snapshot("snap_12")],
        "base-12": [snapshot("snap_base_12")],
        "base-prod": [snapshot("snap_base_prod")],
      },
    })
    server.use(...project.handlers)

    const deleted = await deletePreviewSandboxes({
      credentials,
      environment: EVERY_PREVIEW,
    })

    expect(deleted).toEqual(["chat-12", "base-12"])
    expect(project.requests[0]).toBe("list sandboxes prj_test ")
    expect([...project.sandboxes.keys()]).toEqual([
      "chat-prod",
      "base-prod",
      "chat-abc",
      "chat-12x",
      "chat-untagged",
      "chat-local",
    ])
    expect([...project.snapshots.keys()]).toEqual(["snap_base_prod"])
  })

  it("reads every page of the sandbox list", async () => {
    const project = vercelProject({
      sandboxes: [
        sandbox("chat-prod", "production"),
        sandbox("chat-3", "pr-3"),
        sandbox("chat-4", "pr-4"),
      ],
      snapshots: {},
      pageSize: 2,
    })
    server.use(...project.handlers)

    const deleted = await deletePreviewSandboxes({
      credentials,
      environment: EVERY_PREVIEW,
    })

    expect(deleted).toEqual(["chat-3", "chat-4"])
    expect(project.requests).toContain("list sandboxes prj_test  cursor 2")
    expect([...project.sandboxes.keys()]).toEqual(["chat-prod"])
  })

  it("on one page, deletes what it finds", async () => {
    const project = vercelProject({
      sandboxes: [
        sandbox("chat-3", "pr-3"),
        sandbox("chat-prod", "production"),
      ],
      snapshots: {},
      pageSize: 5,
    })
    server.use(...project.handlers)

    await expect(
      deletePreviewSandboxes({ credentials, environment: EVERY_PREVIEW }),
    ).resolves.toEqual(["chat-3"])
    expect(project.requests.filter((r) => r.includes("cursor"))).toEqual([])
  })

  it("tries every sandbox when one delete fails, then fails the run", async () => {
    const project = vercelProject({
      sandboxes: [sandbox("chat-1", "pr-1"), sandbox("chat-2", "pr-2")],
      snapshots: {},
      failDeleteWith: 403,
      failDeleteOf: "chat-1",
    })
    server.use(...project.handlers)

    await expect(
      deletePreviewSandboxes({ credentials, environment: EVERY_PREVIEW }),
    ).rejects.toMatchObject({ response: { status: 403 } })
    expect([...project.sandboxes.keys()]).toEqual(["chat-1"])
  })

  it("refuses an environment that is not a PR preview", async () => {
    await expect(
      deletePreviewSandboxes({ credentials, environment: "production" }),
    ).rejects.toThrow(/outside a PR preview/)
    await expect(
      deletePreviewSandboxes({ credentials, environment: "" }),
    ).rejects.toThrow(/outside a PR preview/)
  })
})
