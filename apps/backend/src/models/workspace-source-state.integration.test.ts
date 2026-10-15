import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../auth/withAuth.js"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import { workspaceSources } from "../db/schema/workspace_sources.js"
import type { PlannedSourceRow } from "../domain/workspace-sources/projection-plan.js"
import { workspaceGithubReadScope } from "../domain/workspaces/docker-run-vault.js"
import { seedSourcesOrg } from "../test/workspace-sources-fixture.js"
import {
  listLinkedRepositoryPins,
  listServedRepositoryPins,
  updateLinkedRepositoryPin,
} from "./workspace-source-state.js"
import { replaceWorkspaceSourceRows } from "./workspace-sources.js"
import { getLinkedReadBinding, listLinkedRepositories } from "./workspaces.js"

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>

/** Run in the org context of a request: the org-scoped models need it. */
const inOrg = <T>(fn: () => Promise<T>) =>
  withOrgIdContext({ id: seed.orgId, slug: seed.orgId }, fn)

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
      (await inOrg(() => listLinkedRepositories(workspaceId)))
        .map((row) => row.id)
        .sort(),
    ).toEqual(next.map((pin) => pin.id).sort())
  })

  it("keeps the link id and SHAs through a missing connection and a move to another entry", async () => {
    const connection = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace(
      "moves",
      `https://github.com/acme/moves-${seed.suffix}.git`,
    )
    const project = (rows: PlannedSourceRow[], revision: string) =>
      replaceWorkspaceSourceRows({
        orgId: seed.orgId,
        workspaceId,
        revision,
        rows,
      })
    const pins = () =>
      withOrgDbContext(seed.orgId, (db) =>
        listLinkedRepositoryPins(db, { workspaceId }),
      )
    await project([github("repos", connection, ["acme/web"])], "a".repeat(40))
    const [web] = await pins()
    if (!web) throw new Error("web is not linked")
    await withOrgDbContext(seed.orgId, (db) =>
      updateLinkedRepositoryPin(db, web.id, async () => ({
        desiredSha: "b".repeat(40),
      })),
    )
    // While the connection is missing, the repository links nothing.
    await project(
      [github("repos", connection, ["acme/web"], "connection_missing")],
      "c".repeat(40),
    )
    expect(await pins()).toEqual([])
    // On recovery, and after a move to a new entry, the pin is the same.
    await project([github("repos", connection, ["acme/web"])], "d".repeat(40))
    await project([github("code", connection, ["acme/web"])], "e".repeat(40))
    expect(await pins()).toMatchObject([
      { id: web.id, desiredSha: "b".repeat(40) },
    ])
  })

  it("does not undo a pin write that runs during a projection", async () => {
    const connection = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace(
      "locks",
      `https://github.com/acme/locks-${seed.suffix}.git`,
    )
    const rows = [github("repos", connection, ["acme/web"])]
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows,
    })
    const [web] = await withOrgDbContext(seed.orgId, (db) =>
      listLinkedRepositoryPins(db, { workspaceId }),
    )
    if (!web) throw new Error("web is not linked")
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    // The pin write holds its row lock while the projection starts.
    const write = withOrgDbContext(seed.orgId, (db) =>
      updateLinkedRepositoryPin(db, web.id, async () => {
        locked()
        await held
        return { indexedSha: "f".repeat(40) }
      }),
    )
    await isLocked
    const projection = replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows,
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await Promise.all([write, projection])
    expect(
      await withOrgDbContext(seed.orgId, (db) =>
        listLinkedRepositoryPins(db, { workspaceId }),
      ),
    ).toMatchObject([{ id: web.id, indexedSha: "f".repeat(40) }])
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
    const [linked] = await inOrg(() => listLinkedRepositories(workspaceId))
    if (!linked) throw new Error("web is not linked")

    await withOrgDbContext(seed.orgId, (db) =>
      db
        .update(workspaceSources)
        .set({ state: { provider: "github", repositories: "acme/web" } })
        .where(eq(workspaceSources.workspaceId, workspaceId)),
    )
    expect(await inOrg(() => listLinkedRepositories(workspaceId))).toEqual([])
    expect(await inOrg(() => getLinkedReadBinding(linked.id))).toBeNull()

    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: plan,
    })
    expect(
      (await inOrg(() => listLinkedRepositories(workspaceId))).map(
        (row) => row.gitUrl,
      ),
    ).toEqual(["https://github.com/acme/web"])
  })

  it("serves only the pins of ok rows, and keeps the pins of an out_of_access row", async () => {
    const connection = await seed.addConnection("github")
    const workspaceId = await seed.addWorkspace("withdrawn")
    const web = `acme/web-${seed.suffix}`
    const jobs = `acme/jobs-${seed.suffix}`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values(
        [web, jobs].map((name) => ({
          id: `repo_${name.replaceAll(/[^a-z0-9]/gi, "_")}`,
          orgId: seed.orgId,
          name,
          gitUrl: `https://github.com/${name}`,
          githubConnectionId: connection,
        })),
      ),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [
        github("code", connection, [web]),
        github("more", connection, [jobs], "out_of_access"),
      ],
    })
    const urls = (pins: Array<{ gitUrl: string }>) =>
      pins.map((pin) => pin.gitUrl).sort()
    const linked = await withOrgDbContext(seed.orgId, (db) =>
      listLinkedRepositoryPins(db, { workspaceId }),
    )
    expect(urls(linked)).toEqual([
      `https://github.com/${jobs}`,
      `https://github.com/${web}`,
    ])
    expect(
      urls(
        await withOrgDbContext(seed.orgId, (db) =>
          listServedRepositoryPins(db, { workspaceId }),
        ),
      ),
    ).toEqual([`https://github.com/${web}`])
    // A chat sandbox gets no read access to the withdrawn repository.
    expect(
      await workspaceGithubReadScope(seed.orgId, {
        workspaceId,
        generation: 1,
        remote: {
          url: `https://github.com/acme/withdrawn-${seed.suffix}`,
          connectionId: connection,
        },
        defaultBranch: "main",
        sha: "a".repeat(40),
        access: "read",
      }),
    ).toEqual([`acme/withdrawn-${seed.suffix}`, web].sort())

    // When access comes back, the link keeps its id.
    const before = linked.find((pin) => pin.gitUrl.endsWith(jobs))
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "b".repeat(40),
      rows: [
        github("code", connection, [web]),
        github("more", connection, [jobs]),
      ],
    })
    const served = await withOrgDbContext(seed.orgId, (db) =>
      listServedRepositoryPins(db, { workspaceId }),
    )
    expect(served.find((pin) => pin.gitUrl.endsWith(jobs))?.id).toBe(before?.id)
  })
})
