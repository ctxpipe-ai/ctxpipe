import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { stringify } from "yaml"
import {
  cleanUpIngestRefs,
  deleteRunIngestRefs,
  findStepCommit,
  IngestRefRefusedError,
  ingestRefName,
  parseIngestRef,
  pushIngestStep,
} from "./ingest-refs.js"

const SOURCE_URL = "https://github.com/example-org/checkout-api"
const RUN = "run_ingest_1"
const WORKSPACE = "ws_alpha"
const AUTHOR_TIME = new Date("2026-10-01T08:00:00Z")
const HOUR = 60 * 60 * 1000

let root: string
let remote: string
let pinned: string
let fixtureCount = 0

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim()
}

function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

function service(name: string): string {
  return `---\n${stringify({ kind: "Service", name })}---\n# ${name}\n\nThe ${name} service.\n`
}

/** Writes a staged step output: `files/<path>` and `patch.json`. */
function stage(files: Record<string, string>): string {
  fixtureCount += 1
  const dir = join(root, `step-${fixtureCount}`)
  mkdirSync(join(dir, "files"), { recursive: true })
  writeTree(join(dir, "files"), files)
  writeFileSync(
    join(dir, "patch.json"),
    JSON.stringify({
      ops: Object.keys(files).map((path) => ({ op: "create", path })),
    }),
  )
  return dir
}

/** A remote with `main` and nothing else; returns its path. */
function freshRemote(): string {
  fixtureCount += 1
  const dir = join(root, `remote-${fixtureCount}.git`)
  git(root, ["init", "-q", "--bare", "-b", "main", dir])
  git(join(root, "work"), ["push", "-q", dir, "HEAD:refs/heads/main"])
  return dir
}

function remoteRefs(dir: string): Map<string, string> {
  const out = git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"])
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string]),
  )
}

function step(
  input: {
    ref?: string
    oldTip?: string | null
    files?: Record<string, string>
    step?: string
    runId?: string
    workspaceId?: string
    authorTime?: Date
    remoteUrl?: string
  } = {},
) {
  return pushIngestStep({
    job: {
      runId: input.runId ?? RUN,
      workspaceId: input.workspaceId ?? WORKSPACE,
    },
    ref:
      input.ref ??
      ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "0" }),
    oldTip: input.oldTip ?? null,
    pinnedRevision: pinned,
    remote: { url: input.remoteUrl ?? remote },
    commit: {
      step: input.step ?? "skill:services:apis:ws_alpha",
      bundle: "bundle-1",
      authorTime: input.authorTime ?? AUTHOR_TIME,
    },
    patch: {
      stagedDir: stage(
        input.files ?? {
          "knowledge/services/checkout.md": service("Checkout"),
        },
      ),
      source: { url: SOURCE_URL, sha: "1".repeat(40) },
      skill: "apis",
      sourcePathExists: async () => true,
    },
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ingest-refs-"))
  const work = join(root, "work")
  mkdirSync(work)
  git(work, ["init", "-q", "-b", "main"])
  writeTree(work, {
    "AGENTS.md": "# Agents\n",
    "knowledge/services/billing.md": service("Billing"),
  })
  git(work, ["add", "-A"])
  git(work, ["commit", "-q", "-m", "base"])
  pinned = git(work, ["rev-parse", "HEAD"])
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  remote = freshRemote()
})

describe("ingest ref names", () => {
  it("names shard and assembled refs that git can hold together", () => {
    const shard = ingestRefName({
      runId: RUN,
      workspaceId: WORKSPACE,
      shard: "2",
    })
    const assembled = ingestRefName({ runId: RUN, workspaceId: WORKSPACE })
    expect(shard).toBe(`refs/ctxpipe/ingest/${RUN}/${WORKSPACE}/shards/2`)
    expect(assembled).toBe(`refs/ctxpipe/ingest/${RUN}/${WORKSPACE}/assembled`)
    expect(parseIngestRef(shard)).toEqual({
      runId: RUN,
      workspaceId: WORKSPACE,
      shard: "2",
    })
    expect(parseIngestRef(assembled)).toEqual({
      runId: RUN,
      workspaceId: WORKSPACE,
    })
  })

  it("rejects names with unsafe segments", () => {
    for (const bad of [
      "refs/heads/main",
      `refs/ctxpipe/ingest/${RUN}/${WORKSPACE}`,
      `refs/ctxpipe/ingest/${RUN}/../x/assembled`,
      `refs/ctxpipe/ingest/${RUN}/${WORKSPACE}/shards/a/b`,
      `refs/ctxpipe/ingest/${RUN}/${WORKSPACE}/other`,
      "refs/ctxpipe/turns/x/y",
    ])
      expect(parseIngestRef(bad)).toBeNull()
    expect(() =>
      ingestRefName({ runId: "a/b", workspaceId: WORKSPACE }),
    ).toThrow()
  })
})

describe("pushIngestStep", () => {
  it("creates the first step commit on the pinned revision and leaves the default branch", async () => {
    const before = remoteRefs(remote).get("refs/heads/main")
    const result = await step()

    const ref = ingestRefName({
      runId: RUN,
      workspaceId: WORKSPACE,
      shard: "0",
    })
    expect(remoteRefs(remote).get(ref)).toBe(result.sha)
    expect(remoteRefs(remote).get("refs/heads/main")).toBe(before)
    expect(git(remote, ["rev-parse", `${result.sha}^`])).toBe(pinned)
    expect(
      git(remote, ["show", `${result.sha}:knowledge/services/checkout.md`]),
    ).toContain("generated_by: ctxpipe-extract")
    const trailers = git(remote, [
      "log",
      "-1",
      "--format=%(trailers:only,unfold)",
      result.sha,
    ])
    expect(trailers.split("\n")).toEqual([
      `Ctxpipe-Run: ${RUN}`,
      "Ctxpipe-Step: skill:services:apis:ws_alpha",
      "Ctxpipe-Bundle: bundle-1",
    ])
    expect(git(remote, ["log", "-1", "--format=%at %ct", result.sha])).toBe(
      `${AUTHOR_TIME.getTime() / 1000} ${AUTHOR_TIME.getTime() / 1000}`,
    )

    // A default clone does not fetch the ingest ref.
    const clone = join(root, `clone-${fixtureCount}`)
    git(root, ["clone", "-q", remote, clone])
    expect(
      git(clone, ["for-each-ref", "--format=%(refname)"]).split("\n"),
    ).not.toContain(ref)
  })

  it("runs the validator against the base commit and commits only accepted ops", async () => {
    const result = await step({
      files: {
        "knowledge/services/checkout.md": service("Checkout"),
        "AGENTS.md": "# Changed by a model\n",
      },
    })
    expect(result.validation.rejections.map((r) => [r.path, r.rule])).toEqual([
      ["AGENTS.md", "path"],
    ])
    expect(git(remote, ["show", `${result.sha}:AGENTS.md`])).toBe("# Agents")
  })

  it("advances a ref from the expected old tip", async () => {
    const first = await step()
    const second = await step({
      oldTip: first.sha,
      step: "skill:services:libraries:ws_alpha",
      files: { "knowledge/services/ledger.md": service("Ledger") },
    })
    expect(git(remote, ["rev-parse", `${second.sha}^`])).toBe(first.sha)
    expect(
      git(remote, ["ls-tree", "-r", "--name-only", second.sha]).split("\n"),
    ).toEqual(
      expect.arrayContaining([
        "knowledge/services/checkout.md",
        "knowledge/services/ledger.md",
      ]),
    )
  })

  it("makes the same SHA when a step is replayed", async () => {
    const first = await step()
    const otherRemote = freshRemote()
    const replay = await step({ remoteUrl: otherRemote })
    expect(replay.sha).toBe(first.sha)
    // A replay after a push that the caller did not record is a no-op.
    const again = await step()
    expect(again.sha).toBe(first.sha)
    expect(
      remoteRefs(remote).get(
        ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "0" }),
      ),
    ).toBe(first.sha)
  })

  it("refuses a wrong old tip and does not move the ref", async () => {
    const first = await step()
    const ref = ingestRefName({
      runId: RUN,
      workspaceId: WORKSPACE,
      shard: "0",
    })

    // The ref exists, but the job says it is absent.
    await expect(
      step({ step: "skill:services:other:ws_alpha" }),
    ).rejects.toBeInstanceOf(IngestRefRefusedError)
    // The job names an old tip that is not the ref's tip.
    await expect(
      step({ oldTip: pinned, step: "skill:services:other:ws_alpha" }),
    ).rejects.toBeInstanceOf(IngestRefRefusedError)
    // The job names an old tip for a ref that does not exist.
    await expect(
      step({
        ref: ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "1" }),
        oldTip: first.sha,
      }),
    ).rejects.toBeInstanceOf(IngestRefRefusedError)

    expect(remoteRefs(remote).get(ref)).toBe(first.sha)
    expect(
      remoteRefs(remote).has(
        ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "1" }),
      ),
    ).toBe(false)
  })

  it("lets one of two racing pushes win and refuses the other", async () => {
    const results = await Promise.allSettled([
      step({ step: "skill:services:apis:ws_alpha" }),
      step({
        step: "skill:services:libraries:ws_alpha",
        files: { "knowledge/services/ledger.md": service("Ledger") },
      }),
    ])
    const won = results.flatMap((r) => (r.status === "fulfilled" ? [r] : []))
    const lost = results.flatMap((r) => (r.status === "rejected" ? [r] : []))
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]?.reason).toBeInstanceOf(IngestRefRefusedError)
    expect(
      remoteRefs(remote).get(
        ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "0" }),
      ),
    ).toBe(won[0]?.value.sha)
  })

  it("refuses a ref outside the run's names", async () => {
    const before = remoteRefs(remote)
    for (const ref of [
      "refs/heads/main",
      "refs/heads/ingest",
      ingestRefName({ runId: "run_other", workspaceId: WORKSPACE }),
      ingestRefName({ runId: RUN, workspaceId: "ws_other", shard: "0" }),
      `refs/ctxpipe/ingest/${RUN}/${WORKSPACE}`,
      "refs/ctxpipe/turns/x/y",
    ])
      await expect(step({ ref })).rejects.toBeInstanceOf(IngestRefRefusedError)
    expect(remoteRefs(remote)).toEqual(before)
  })
})

describe("findStepCommit", () => {
  it("finds a step's commit on the tip after a crash after the push", async () => {
    const ref = ingestRefName({
      runId: RUN,
      workspaceId: WORKSPACE,
      shard: "0",
    })
    const pushed = await step()
    // The worker died before the step output was recorded. The retry asks the ref.
    await expect(
      findStepCommit({
        remote: { url: remote },
        ref,
        runId: RUN,
        step: "skill:services:apis:ws_alpha",
      }),
    ).resolves.toBe(pushed.sha)
    await expect(
      findStepCommit({
        remote: { url: remote },
        ref,
        runId: RUN,
        step: "skill:services:libraries:ws_alpha",
      }),
    ).resolves.toBeNull()
    await expect(
      findStepCommit({
        remote: { url: remote },
        ref,
        runId: "run_other",
        step: "skill:services:apis:ws_alpha",
      }),
    ).resolves.toBeNull()
    await expect(
      findStepCommit({
        remote: { url: remote },
        ref: ingestRefName({ runId: RUN, workspaceId: WORKSPACE, shard: "9" }),
        runId: RUN,
        step: "skill:services:apis:ws_alpha",
      }),
    ).resolves.toBeNull()
  })
})

describe("deleteRunIngestRefs", () => {
  it("deletes the refs of one run and Workspace and can run again", async () => {
    await step()
    await step({ ref: ingestRefName({ runId: RUN, workspaceId: WORKSPACE }) })
    const kept = ingestRefName({ runId: "run_other", workspaceId: WORKSPACE })
    await step({ runId: "run_other", ref: kept })

    for (let i = 0; i < 2; i++)
      await deleteRunIngestRefs({
        remote: { url: remote },
        runId: RUN,
        workspaceId: WORKSPACE,
      })
    expect(
      [...remoteRefs(remote).keys()].filter((r) =>
        r.startsWith("refs/ctxpipe/"),
      ),
    ).toEqual([kept])
  })
})

describe("cleanUpIngestRefs", () => {
  const now = new Date("2026-10-10T12:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms)

  async function seed() {
    const refs = {
      finished: ingestRefName({ runId: "run_done", workspaceId: WORKSPACE }),
      running: ingestRefName({ runId: "run_live", workspaceId: WORKSPACE }),
      stale: ingestRefName({ runId: "run_stuck", workspaceId: WORKSPACE }),
    }
    await step({ runId: "run_done", ref: refs.finished, authorTime: ago(HOUR) })
    await step({ runId: "run_live", ref: refs.running, authorTime: ago(HOUR) })
    await step({
      runId: "run_stuck",
      ref: refs.stale,
      authorTime: ago(25 * HOUR),
    })
    return refs
  }

  it("deletes a finished run's refs and refs over 24 hours, and keeps a running run's refs", async () => {
    const main = remoteRefs(remote).get("refs/heads/main")
    const refs = await seed()
    const asked: string[][] = []
    const result = await cleanUpIngestRefs({
      remote: { url: remote },
      now,
      shadow: false,
      unfinishedRunIds: async (ids) => {
        asked.push([...ids].sort())
        return new Set(ids.filter((id) => id !== "run_done"))
      },
    })
    expect(asked).toEqual([["run_done", "run_live", "run_stuck"]])
    expect(result.deleted.sort()).toEqual([refs.finished, refs.stale].sort())
    const after = remoteRefs(remote)
    expect(after.has(refs.running)).toBe(true)
    expect(after.has(refs.finished)).toBe(false)
    expect(after.has(refs.stale)).toBe(false)
    expect(after.get("refs/heads/main")).toBe(main)
  })

  it("keeps shadow refs for 7 days, also after the run has finished", async () => {
    const refs = await seed()
    const old = ingestRefName({ runId: "run_old", workspaceId: WORKSPACE })
    await step({ runId: "run_old", ref: old, authorTime: ago(8 * 24 * HOUR) })
    const result = await cleanUpIngestRefs({
      remote: { url: remote },
      now,
      shadow: true,
      unfinishedRunIds: async () => new Set(["run_live"]),
    })
    expect(result.deleted).toEqual([old])
    const after = remoteRefs(remote)
    for (const ref of Object.values(refs)) expect(after.has(ref)).toBe(true)
  })

  it("does nothing and asks for no run when the remote has no ingest refs", async () => {
    let asked = false
    const result = await cleanUpIngestRefs({
      remote: { url: remote },
      now,
      shadow: false,
      unfinishedRunIds: async () => {
        asked = true
        return new Set()
      },
    })
    expect(result.deleted).toEqual([])
    expect(asked).toBe(false)
  })
})
