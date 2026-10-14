import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgDbContext } from "../db/client.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import { seedSourcesOrg } from "../test/workspace-sources-fixture.js"
import {
  listLinkedRepositoryPins,
  updateLinkedRepositoryPin,
} from "./workspace-source-state.js"
import { replaceWorkspaceSourceRows } from "./workspace-sources.js"
import { getLinkedReadBinding, listLinkedRepositories } from "./workspaces.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

const github = (
  sourceKey: string,
  connectionId: string,
  repositories: unknown[],
  status: PlannedSourceRow["status"] = "ok",
): PlannedSourceRow => ({
  sourceKey,
  provider: "github",
  connectionId,
  scope: { repositories },
  status,
  statusDetail: null,
})

describe("workspace source state (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_state")
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("keeps link ids and SHAs, renews a changed ref, and drops a removed repository", async () => {
    const connection = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace(
      "docs",
      `https://github.com/acme/docs-${seed.suffix}.git`,
    )
    const own = `acme/docs-${seed.suffix}`
    const project = (rows: PlannedSourceRow[], revision: string) =>
      replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision,
        rows,
      })
    // In URL order: pins made in one projection share their creation time.
    const pins = async () =>
      (
        await withOrgDbContext(seed.orgId, (db) =>
          listLinkedRepositoryPins(db, { workspaceId }),
        )
      ).sort((a, b) => a.gitUrl.localeCompare(b.gitUrl))

    const plan = [
      github("repos", connection, [
        "acme/web",
        { name: "acme/api", ref: "release" },
        own,
      ]),
      github("more", connection, ["Acme/Web", "acme/jobs"], "out_of_access"),
      github("gone", "con_missing_conn", ["acme/hidden"], "connection_missing"),
    ]
    await project(plan, "a".repeat(40))
    const first = await pins()
    // The Workspace repository, a repeated repository, and a source without
    // a usable connection link nothing.
    expect(first.map((pin) => [pin.gitUrl, pin.desiredRef])).toEqual([
      ["https://github.com/acme/api", "release"],
      ["https://github.com/acme/jobs", null],
      ["https://github.com/acme/web", null],
    ])
    expect(first.every((pin) => pin.id.startsWith("wlr_"))).toBe(true)
    const web = first[2]
    if (!web) throw new Error("web is not linked")

    expect(
      await withOrgDbContext(seed.orgId, (db) =>
        updateLinkedRepositoryPin(db, web.id, async () => ({
          desiredSha: "b".repeat(40),
        })),
      ),
    ).toBe(true)

    // The same plan again changes no row and keeps the pins.
    expect(await project(plan, "c".repeat(40))).toEqual({
      added: [],
      changed: [],
      removed: [],
    })
    expect((await pins())[2]).toMatchObject({
      id: web.id,
      desiredSha: "b".repeat(40),
    })

    await project(
      [
        github("repos", connection, [
          "acme/web",
          { name: "acme/api", ref: "main" },
        ]),
      ],
      "d".repeat(40),
    )
    const next = await pins()
    expect(next.map((pin) => [pin.gitUrl, pin.desiredRef])).toEqual([
      ["https://github.com/acme/api", "main"],
      ["https://github.com/acme/web", null],
    ])
    expect(next[1]).toMatchObject({ id: web.id, desiredSha: "b".repeat(40) })
    expect(next[0]?.id).not.toBe(first[0]?.id)

    // The linked-repositories API keeps the stable id.
    expect(
      (
        await withOrgDbContext(seed.orgId, () =>
          listLinkedRepositories(workspaceId),
        )
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual(next.map((pin) => pin.id).sort())
  })

  it("reads an invalid state as empty, and the next projection writes it again", async () => {
    const connection = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace("broken")
    const plan = [github("repos", connection, ["acme/web"])]
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: plan,
    })
    const [linked] = await withOrgDbContext(seed.orgId, () =>
      listLinkedRepositories(workspaceId),
    )
    if (!linked) throw new Error("web is not linked")

    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaceSources)
        .set({ state: { provider: "github", repositories: "acme/web" } })
        .where(eq(workspaceSources.workspaceId, workspaceId)),
    )
    expect(
      await withOrgDbContext(seed.orgId, () =>
        listLinkedRepositories(workspaceId),
      ),
    ).toEqual([])
    expect(
      await withOrgDbContext(seed.orgId, () => getLinkedReadBinding(linked.id)),
    ).toBeNull()

    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: plan,
    })
    expect(
      (
        await withOrgDbContext(seed.orgId, () =>
          listLinkedRepositories(workspaceId),
        )
      ).map((row) => row.gitUrl),
    ).toEqual(["https://github.com/acme/web"])
  })
})
