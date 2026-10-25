import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaceKnowledgeUnits } from "../../db/schema/workspaces.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { hydrateKnowledgeTree } from "../workspaces/hydrate.js"
import {
  buildContextIndex,
  CONTEXT_INDEX_MAX_ENTRIES,
} from "./context-index.js"

// Source file paths (`sources`, ADR-050 revision 2026-10-16).
const sourcePath = "sources/github/acme/app.md"
const otherPath = "sources/github/acme/other.md"

function generated(name: string, sources: string[], body = "Body.\n") {
  return `---\nkind: Service\nname: ${name}\ngenerated_by: ctxpipe-extract\nsources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n---\n${body}`
}

const files: Record<string, string> = {
  "knowledge/services/api.md": generated("API service", [sourcePath]).replace(
    "kind: Service\n",
    "kind: Service\nsummary: Serves the public API.\n",
  ),
  "knowledge/services/shared.md": generated("Shared", [sourcePath, otherPath]),
  "knowledge/services/theirs.md": generated("Theirs", [otherPath]),
  // A human removed the generated_by field, so the file is theirs now.
  "knowledge/services/taken.md":
    "---\nkind: Service\nname: Taken over\nsources:\n  - https://github.com/acme/app\n---\nHuman text.\n",
  "knowledge/guides/plain.md":
    "# Plain heading\n\nNo front matter, but a [link](../services/api.md#x) and [web](https://example.com).\n",
}

let ctx: Awaited<ReturnType<typeof seedSourcesOrg>>
let workspaceId: string
let repo: Awaited<
  ReturnType<Awaited<ReturnType<typeof seedSourcesOrg>>["gitRepository"]>
>
let sha: string

async function project(sha: string, files: Record<string, string>) {
  const { units } = hydrateKnowledgeTree({
    workspaceId,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  })
  // A projection replaces the earlier one, as commitHydrateProjection does.
  await withOrgDbContext(ctx.orgId, (db) =>
    db
      .delete(workspaceKnowledgeUnits)
      .where(eq(workspaceKnowledgeUnits.workspaceId, workspaceId)),
  )
  await withOrgDbContext(ctx.orgId, (db) =>
    db.insert(workspaceKnowledgeUnits).values(
      units.map((unit) => ({
        servingId: unit.servingId,
        orgId: ctx.orgId,
        workspaceId,
        path: unit.path,
        kind: unit.kind ?? null,
        body: unit.body,
        projectionSha: sha,
        links: unit.links,
        claims: unit.claims,
      })),
    ),
  )
}

const build = (input: Parameters<typeof buildContextIndex>[0]) =>
  withOrgIdContext({ id: ctx.orgId, slug: ctx.orgId }, () =>
    buildContextIndex(input),
  )

describe("buildContextIndex (Postgres, git)", () => {
  beforeAll(async () => {
    ctx = await seedSourcesOrg("ctxindex")
    workspaceId = await ctx.addWorkspace("ctxindex")
    repo = await ctx.gitRepository()
    sha = await repo.commit(files)
    await project(sha, files)
  })
  afterAll(() => ctx.cleanup())

  it("reads the raw files below the Workspace root folder", async () => {
    const rooted = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        `docs/context/${path}`,
        content,
      ]),
    )
    const rootedSha = await repo.commit(rooted)
    await project(rootedSha, files)
    try {
      const { index } = await build({
        workspaceId,
        sha: rootedSha,
        sourcePath,
        repoDir: repo.dir,
        rootPath: "docs/context",
      })
      expect(
        index.entries.find(
          (entry) => entry.path === "knowledge/services/api.md",
        ),
      ).toMatchObject({ summary: "Serves the public API.", owned: true })
    } finally {
      await project(sha, files)
    }
  })

  it("lists each unit with title, sources, and the owned flag", async () => {
    const { index } = await build({
      workspaceId,
      sha,
      sourcePath,
      repoDir: repo.dir,
    })
    expect(index).toMatchObject({
      workspaceId,
      revision: sha,
      total: 5,
      truncated: false,
    })
    expect(index.entries).toEqual([
      {
        path: "knowledge/guides/plain.md",
        kind: null,
        title: "Plain heading",
        summary:
          "No front matter, but a [link](../services/api.md#x) and [web](https://example.com).",
        links: ["knowledge/services/api.md"],
        sources: [],
        owned: false,
      },
      {
        path: "knowledge/services/api.md",
        kind: "Service",
        title: "API service",
        summary: "Serves the public API.",
        links: [],
        sources: [sourcePath],
        owned: true,
      },
      {
        path: "knowledge/services/shared.md",
        kind: "Service",
        title: "Shared",
        summary: "Body.",
        links: [],
        sources: [sourcePath, otherPath],
        owned: true,
      },
      {
        path: "knowledge/services/taken.md",
        kind: "Service",
        title: "Taken over",
        summary: "Human text.",
        links: [],
        sources: [],
        owned: false,
      },
      {
        path: "knowledge/services/theirs.md",
        kind: "Service",
        title: "Theirs",
        summary: "Body.",
        links: [],
        sources: [otherPath],
        owned: false,
      },
    ])
  })

  it("does not own a file for another source", async () => {
    const { index } = await build({
      workspaceId,
      sha,
      sourcePath: "sources/github/acme/unrelated.md",
      repoDir: repo.dir,
    })
    expect(index.entries.some((e) => e.owned)).toBe(false)
  })

  it("gives the same bytes for the same revision", async () => {
    const input = { workspaceId, sha, sourcePath, repoDir: repo.dir }
    expect((await build(input)).json).toBe((await build(input)).json)
  })

  it("lists only the units of the pinned revision", async () => {
    // `repoDir` holds the pinned revision, but no projection is at it.
    const unprojected = await repo.commit({
      "knowledge/guides/later.md": "# Later\n",
    })
    const { index } = await build({
      workspaceId,
      sha: unprojected,
      sourcePath,
      repoDir: repo.dir,
    })
    expect(index.entries).toEqual([])
  })

  it("keeps owned entries first and says so when the cap applies", async () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < CONTEXT_INDEX_MAX_ENTRIES + 20; i++) {
      const n = String(i).padStart(5, "0")
      many[`knowledge/guides/g${n}.md`] = `# Guide ${n}\n`
    }
    many["knowledge/services/zz-owned.md"] = generated("Owned", [sourcePath])
    const bigSha = await repo.commit(many)
    await project(bigSha, many)
    const { index, json } = await build({
      workspaceId,
      sha: bigSha,
      sourcePath,
      repoDir: repo.dir,
    })
    expect(index.truncated).toBe(true)
    expect(index.total).toBe(CONTEXT_INDEX_MAX_ENTRIES + 21)
    expect(index.entries.length).toBeLessThan(index.total)
    expect(
      index.entries.find((e) => e.path.endsWith("zz-owned.md"))?.owned,
    ).toBe(true)
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(256 * 1024)
  })
})
