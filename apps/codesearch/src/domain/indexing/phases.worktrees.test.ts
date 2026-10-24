import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"
import {
  bareRepository,
  git,
  startGitHttpServer,
} from "../../test/gitHttpServer.js"

// config/paths.js reads these variables when it loads.
const { cacheRoot } = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-cache-")))
  vi.stubEnv("REPO_CACHE_DIR", join(root, "repo-cache"))
  vi.stubEnv("ZOEKT_INDEX_DIR", join(root, "zoekt-index"))
  return { cacheRoot: root }
})

import {
  deleteCheckoutFromDisk,
  sweepRepositoryDisk,
} from "../repositories/checkoutGc.js"
import { repoCheckoutPath } from "../repositories/paths.js"
import { repoSharedClonePath } from "../repositories/worktrees.js"
import { zoektRepositoryName } from "../zoekt/shardPrefix.js"
import { phaseCloneCheckout } from "./phases.js"

/*
 * Each repository has one shared bare clone; each checkout key is a git
 * worktree of it. Real git against a real local Git HTTP server.
 */

const ORG = "org_wt"
let root: string
let server: Awaited<ReturnType<typeof startGitHttpServer>>
const shas: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codesearch-worktrees-"))
  const repos = join(root, "repos")
  shas.push(await bareRepository(repos, "team/app.git", { "a.txt": "0\n" }))
  // Five more commits on main, so a depth-1 clone must deepen for a diff.
  const work = join(root, "work")
  await git(["clone", "-q", join(repos, "team/app.git"), work])
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=t"]
  for (let n = 1; n <= 5; n++) {
    await writeFile(join(work, "a.txt"), `${n}\n`)
    if (n === 3) await writeFile(join(work, "b.txt"), "new\n")
    await git([...who, "commit", "-qam", `c${n}`], work)
    if (n === 3) await git([...who, "add", "b.txt"], work)
    if (n === 3) await git([...who, "commit", "-qm", "b"], work)
    shas.push(await git(["rev-parse", "HEAD"], work))
  }
  await git(["push", "-q", "origin", "main"], work)
  server = await startGitHttpServer(repos)
})

afterAll(async () => {
  await server?.stop()
  await rm(root, { recursive: true, force: true })
  await rm(cacheRoot, { recursive: true, force: true })
})

function context(repoId: string, checkoutKey: string) {
  const url = `http://127.0.0.1:${server.port}/team/app.git`
  return {
    // Step writes are best-effort; an unusable database only drops them.
    db: {} as Db,
    orgId: ORG,
    repoId,
    repoGitUrl: url,
    plainGit: { url, http: true },
    checkoutKey,
    clonePath: repoCheckoutPath(ORG, repoId, checkoutKey),
    sharedClonePath: repoSharedClonePath(ORG, repoId),
    scipIndexPath: join(root, "unused.scip"),
    zoektRepoId: 1,
    zoektName: zoektRepositoryName({ orgId: ORG, repoId, checkoutKey }),
    repoName: "team/app",
    repoUrl: url,
  }
}

const rev = (sha: string) => `rev:${sha}`
const worktreeList = (repoId: string) =>
  git(["worktree", "list", "--porcelain"], repoSharedClonePath(ORG, repoId))

describe("checkouts as worktrees of one shared clone", () => {
  it("creates a worktree at the key path, and reuses it on the next run", async () => {
    const key = rev(shas[5] as string)
    const ctx = context("repo_create", key)
    const first = await phaseCloneCheckout(ctx, { targetHash: shas[5] })
    expect(first.targetHash).toBe(shas[5])
    expect((await stat(join(ctx.clonePath, ".git"))).isFile()).toBe(true)
    expect(await readFile(join(ctx.clonePath, "a.txt"), "utf8")).toBe("5\n")
    expect(await worktreeList("repo_create")).toContain(ctx.clonePath)

    await writeFile(join(ctx.clonePath, "marker"), "kept")
    await phaseCloneCheckout(ctx, { targetHash: shas[5] })
    // The same worktree: not deleted and made again.
    expect(await readFile(join(ctx.clonePath, "marker"), "utf8")).toBe("kept")
    expect(await git(["rev-parse", "HEAD"], ctx.clonePath)).toBe(shas[5])
  })

  it("runs two keys of one repository at the same time on one clone", async () => {
    const a = context("repo_two", rev(shas[5] as string))
    const b = context("repo_two", rev(shas[4] as string))
    const [ra, rb] = await Promise.all([
      phaseCloneCheckout(a, { targetHash: shas[5] }),
      phaseCloneCheckout(b, { targetHash: shas[4] }),
    ])
    expect([ra.targetHash, rb.targetHash]).toEqual([shas[5], shas[4]])
    expect(await git(["rev-parse", "HEAD"], a.clonePath)).toBe(shas[5])
    expect(await git(["rev-parse", "HEAD"], b.clonePath)).toBe(shas[4])
    const list = await worktreeList("repo_two")
    expect(list).toContain(a.clonePath)
    expect(list).toContain(b.clonePath)
    // No git lock file stays behind.
    const shared = repoSharedClonePath(ORG, "repo_two")
    await expect(stat(join(shared, "index.lock"))).rejects.toThrow()
    await expect(stat(join(shared, "shallow.lock"))).rejects.toThrow()
  })

  it("finds the merge base after a shallow shared clone and gives a partial diff", async () => {
    const ctx = context("repo_diff", rev(shas[5] as string))
    // The depth-1 clone has only the tip; the diff needs older commits.
    const result = await phaseCloneCheckout(ctx, {
      targetHash: shas[5],
      fromHash: shas[1],
    })
    expect(result.ingestMode).toBe("partial")
    expect(result.changedPaths.sort()).toEqual(["a.txt", "b.txt"])
  })

  it("replaces an old standalone clone at the key path with a worktree", async () => {
    const ctx = context("repo_old", rev(shas[5] as string))
    await git(["clone", "-q", ctx.repoGitUrl, ctx.clonePath])
    expect((await stat(join(ctx.clonePath, ".git"))).isDirectory()).toBe(true)
    await phaseCloneCheckout(ctx, { targetHash: shas[5] })
    expect((await stat(join(ctx.clonePath, ".git"))).isFile()).toBe(true)
    expect(await worktreeList("repo_old")).toContain(ctx.clonePath)
  })

  it("removes the worktree and its registration when a key is deleted", async () => {
    const key = rev(shas[5] as string)
    const ctx = context("repo_remove", key)
    await phaseCloneCheckout(ctx, { targetHash: shas[5] })
    await writeFile(`${ctx.clonePath}.scip`, "scip")
    await deleteCheckoutFromDisk({
      orgId: ORG,
      repoId: "repo_remove",
      checkoutKey: key,
      zoektRepoId: 1,
    })
    await expect(stat(ctx.clonePath)).rejects.toThrow()
    await expect(stat(`${ctx.clonePath}.scip`)).rejects.toThrow()
    expect(await worktreeList("repo_remove")).not.toContain(ctx.clonePath)
    // The shared clone stays for the next run.
    expect(
      (await stat(repoSharedClonePath(ORG, "repo_remove"))).isDirectory(),
    ).toBe(true)
  })
})

describe("sweepRepositoryDisk", () => {
  const repoId = "repo_sweep"
  const old = new Date(Date.now() - 2 * 3_600_000)
  const zoektDir = join(cacheRoot, "zoekt-index")
  const shard = (key?: string, suffix = "") =>
    join(
      zoektDir,
      `${encodeURIComponent(zoektRepositoryName({ orgId: ORG, repoId, checkoutKey: key }))}_v16.00000.zoekt${suffix}`,
    )

  it("deletes old files with no row and keeps rows, the published key, and new files", async () => {
    const published = rev(shas[5] as string)
    const withRow = rev(shas[4] as string)
    const orphan = rev(shas[3] as string)
    const fresh = rev(shas[2] as string)
    for (const [key, sha] of [
      [published, shas[5]],
      [withRow, shas[4]],
      [orphan, shas[3]],
      [fresh, shas[2]],
    ] as const)
      await phaseCloneCheckout(context(repoId, key), { targetHash: sha })
    const checkouts = join(cacheRoot, "repo-cache", ORG, repoId, "checkouts")
    const legacyWorkspace = join(checkouts, "ws:ws_old")
    await mkdir(legacyWorkspace, { recursive: true })
    await writeFile(join(checkouts, `${orphan}.scip`), "x")
    await writeFile(join(checkouts, `${withRow}.scip.123.tmp`), "x")
    await mkdir(zoektDir, { recursive: true })
    for (const path of [
      shard(orphan),
      shard(withRow),
      shard(published),
      `${shard(withRow)}.456.tmp`,
    ])
      await writeFile(path, "shard")
    // Another repository whose id starts with this id: never touched.
    const other = join(
      zoektDir,
      `${encodeURIComponent(zoektRepositoryName({ orgId: ORG, repoId: `${repoId}x`, checkoutKey: orphan }))}_v16.00000.zoekt`,
    )
    await writeFile(other, "shard")
    for (const name of [
      orphan,
      published,
      withRow,
      `${orphan}.scip`,
      `${withRow}.scip.123.tmp`,
      "ws:ws_old",
    ])
      await utimes(join(checkouts, name), old, old)
    for (const path of [
      shard(orphan),
      shard(withRow),
      shard(published),
      `${shard(withRow)}.456.tmp`,
      other,
    ])
      await utimes(path, old, old)

    const result = await sweepRepositoryDisk({
      orgId: ORG,
      repoId,
      rowKeys: new Set([withRow]),
      publishedCheckoutKey: published,
      minAgeMs: 3_600_000,
    })

    const exists = (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      )
    expect(await exists(join(checkouts, orphan))).toBe(false)
    expect(await exists(join(checkouts, `${orphan}.scip`))).toBe(false)
    expect(await exists(legacyWorkspace)).toBe(false)
    expect(await exists(join(checkouts, `${withRow}.scip.123.tmp`))).toBe(false)
    expect(await exists(shard(orphan))).toBe(false)
    expect(await exists(`${shard(withRow)}.456.tmp`)).toBe(false)
    expect(await exists(join(checkouts, published))).toBe(true)
    expect(await exists(join(checkouts, withRow))).toBe(true)
    expect(await exists(join(checkouts, fresh))).toBe(true)
    expect(await exists(shard(withRow))).toBe(true)
    expect(await exists(shard(published))).toBe(true)
    expect(await exists(other)).toBe(true)
    expect(result.deletedEntries).toBe(6)
    expect(result.deletedBytes).toBeGreaterThan(0)
    expect(await worktreeList(repoId)).not.toContain(join(checkouts, orphan))
  })
})
