import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { stringify } from "yaml"

import {
  findStepCommit,
  ingestRefName,
  ingestRunRefTip,
  listStepFiles,
  pushIngestStep,
} from "../../domain/ingestion/ingest-refs.js"
import type { IngestShardRuntime } from "../../domain/ingestion/ingest-shard-runtime.js"
import { skillStepName } from "../../domain/ingestion/ingestion-plan.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import {
  type IngestionShardWorkspace,
  runSkillPages,
  type SkillStepBroker,
} from "./ingestion-shard.js"

/*
 * `runSkillPages` with a step function that returns the step result and runs
 * no sandbox: the partial accounting of a root (concept section 7.3). The
 * module makes an OpenWorkflow client when it loads, so it needs a database.
 */

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the ingestion shard module")
})

function pages(
  root: string | null,
  results: Array<
    | { partial: true }
    | { tip: string; ops: number; rejects: number; more: boolean }
  >,
) {
  const state: IngestionShardWorkspace = {
    workspaceId: "ws_alpha",
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
    partialRoots: [],
  }
  const run = withLogger(createLogger({ test: "skill-pages" }), () =>
    runSkillPages({
      step: async () => {
        const result = results.shift()
        if (!result) throw new Error("No more step results")
        return result
      },
      root,
      skill: { name: "apis" },
      run: { runId: "run_fixture" },
      destination: { workspaceId: "ws_alpha" },
      state,
    } as unknown as Parameters<typeof runSkillPages>[0]),
  )
  return run.then(() => state)
}

describe("runSkillPages", () => {
  it("records the root of a step that failed", async () => {
    const state = await pages("services/a", [{ partial: true }])
    expect(state).toMatchObject({ partial: 1, partialRoots: ["services/a"] })
  })

  it("records the root of a skill that stops with files left", async () => {
    const state = await pages("services/b", [
      { tip: "a".repeat(40), ops: 0, rejects: 1, more: true },
    ])
    expect(state).toMatchObject({ partial: 1, partialRoots: ["services/b"] })
  })

  it("records no root for a repository-wide step", async () => {
    const state = await pages(null, [{ partial: true }])
    expect(state).toMatchObject({ partial: 1, partialRoots: [] })
  })

  it("records no root for a root whose steps all pass", async () => {
    const state = await pages("services/c", [
      { tip: "a".repeat(40), ops: 1, rejects: 0, more: false },
    ])
    expect(state).toMatchObject({ partial: 0, partialRoots: [] })
  })
})

/*
 * Two executions of one shard child on one shard ref (CTX-1073). The broker
 * is the real git code on a local remote; only the sandbox is a stub, which
 * returns the tar of a staged step output.
 */
describe("runSkillPages on a shard ref that another execution moved", () => {
  const RUN = "run_twice"
  const WS = "ws_alpha"
  const ROOT = "services/a"
  const SOURCE = {
    url: "https://github.com/example-org/shop",
    sha: "1".repeat(40),
  }
  const SOURCE_PATH = "sources/github/example-org/shop.md"
  const REF = ingestRefName({ runId: RUN, workspaceId: WS, shard: "0" })
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    COPYFILE_DISABLE: "1",
  }
  let dir: string
  let remote: string
  let pinned: string
  let count = 0

  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim()
  const service = (name: string) =>
    `---\n${stringify({ kind: "Service", name })}---\n# ${name}\n\nThe ${name} service.\n`

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ingest-twice-"))
    const work = join(dir, "work")
    mkdirSync(work)
    git(work, ["init", "-q", "-b", "main"])
    writeFileSync(join(work, "AGENTS.md"), "# Agents\n")
    git(work, ["add", "-A"])
    git(work, ["commit", "-q", "-m", "base"])
    pinned = git(work, ["rev-parse", "HEAD"])
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function freshRemote() {
    remote = join(dir, `remote-${++count}.git`)
    git(dir, ["init", "-q", "--bare", "-b", "main", remote])
    git(join(dir, "work"), ["push", "-q", remote, "HEAD:refs/heads/main"])
  }

  /** A staged step output (`files/<path>` and `patch.json`). */
  function staged(files: Record<string, string>): string {
    const out = join(dir, `step-${++count}`)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(out, "files", path)), { recursive: true })
      writeFileSync(join(out, "files", path), content)
    }
    writeFileSync(
      join(out, "patch.json"),
      JSON.stringify({
        ops: Object.keys(files).map((path) => ({ op: "create", path })),
      }),
    )
    return out
  }

  const patch = (stagedDir: string) => ({
    stagedDir,
    source: SOURCE,
    sourcePath: SOURCE_PATH,
    skill: "apis",
    sourcePathExists: async () => true,
    readSourceFile: async () => null,
  })

  /** The other execution pushes `skill` on the ref from `oldTip`. */
  function otherExecutionPushes(
    skill: string,
    oldTip: string,
    files: Record<string, string>,
  ) {
    return pushIngestStep({
      job: { runId: RUN, workspaceId: WS },
      ref: REF,
      oldTip,
      pinnedRevision: pinned,
      baseCommit: oldTip,
      remote: { url: remote },
      commit: {
        step: skillStepName(ROOT, skill, WS),
        bundle: "bundle-1",
        authorTime: new Date("2026-10-01T08:00:00Z"),
      },
      patch: patch(staged(files)),
    })
  }

  const broker: SkillStepBroker = {
    find: (ref, step) =>
      findStepCommit({ remote: { url: remote }, ref, runId: RUN, step }),
    listFiles: (pinnedRevision, tip) =>
      listStepFiles({
        remote: { url: remote },
        runId: RUN,
        pinnedRevision,
        tip,
      }),
    push: (input) =>
      pushIngestStep({
        ...input,
        job: { runId: RUN, workspaceId: WS },
        remote: { url: remote },
      }),
    runTip: (ref, given) =>
      ingestRunRefTip({ remote: { url: remote }, ref, runId: RUN, given }),
    sourcePathExists: async () => true,
    readSourceFile: async () => null,
  }

  /** The sandbox stub: it stages `files`, after `during` runs. */
  function sandbox(
    files: Record<string, string>,
    during?: () => Promise<void>,
  ) {
    const calls: string[] = []
    const runtime = {
      runStep: async (step: { name: string }) => {
        calls.push(step.name)
        await during?.()
        return {
          tar: new Uint8Array(
            execFileSync("tar", ["-C", staged(files), "-cf", "-", "."], {
              env: GIT_ENV,
            }),
          ),
        }
      },
    } as unknown as IngestShardRuntime
    return { runtime, calls }
  }

  function runSkill(
    skill: string,
    state: IngestionShardWorkspace,
    runtime: IngestShardRuntime,
  ) {
    return withLogger(createLogger({ test: "skill-pages-twice" }), () =>
      runSkillPages({
        step: (_name, fn) => fn(),
        run: {
          runId: RUN,
          bundle: "bundle-1",
          source: {
            ...SOURCE,
            githubConnectionId: "con_fixture",
            repositoryId: null,
          },
          authorTime: "2026-10-01T08:00:00.000Z",
          roots: [{ path: ROOT, manifests: [], evidence: [] }],
          shard: 0,
        },
        broker,
        runtime,
        root: ROOT,
        skill: { name: skill, scope: "root", run: "script" },
        destination: {
          workspaceId: WS,
          url: "https://github.com/example-org/context",
          githubConnectionId: "con_fixture",
          generation: 1,
          pinnedRevision: pinned,
          repositoryId: null,
          sourcePath: SOURCE_PATH,
        },
        ref: REF,
        runBase: pinned,
        state,
      } as Parameters<typeof runSkillPages>[0]),
    )
  }

  const workspace = (): IngestionShardWorkspace => ({
    workspaceId: WS,
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
    partialRoots: [],
  })

  it("goes on from the other execution's commit, with no refusal and no partial step", async () => {
    freshRemote()
    const state = workspace()
    await runSkill(
      "classify-kind",
      state,
      sandbox({ "knowledge/services/a.md": service("A") }).runtime,
    )
    const ownTip = state.tip ?? ""
    // The other execution ran `apis`; this one's tip is still at `classify-kind`.
    const other = await otherExecutionPushes("apis", ownTip, {
      "knowledge/services/api.md": service("Api"),
    })
    await runSkill(
      "dependencies",
      state,
      sandbox({ "knowledge/services/deps.md": service("Deps") }).runtime,
    )
    expect(state.partial).toBe(0)
    expect(git(remote, ["rev-parse", REF])).toBe(state.tip)
    expect(git(remote, ["rev-parse", `${state.tip}^`])).toBe(other.sha)
  })

  it("takes the other execution's commit of the same step and does not run the step again", async () => {
    freshRemote()
    const state = workspace()
    await runSkill(
      "classify-kind",
      state,
      sandbox({ "knowledge/services/a.md": service("A") }).runtime,
    )
    const ownTip = state.tip ?? ""
    let other = ""
    // The other execution pushes the same step while this one runs it.
    const { runtime, calls } = sandbox(
      { "knowledge/services/deps.md": service("Deps") },
      async () => {
        if (other) return
        // Its own model run wrote other content: another commit.
        other = (
          await otherExecutionPushes("dependencies", ownTip, {
            "knowledge/services/deps.md": service("Deps of the other run"),
          })
        ).sha
      },
    )
    await runSkill("dependencies", state, runtime)
    expect(state).toMatchObject({ partial: 0, tip: other })
    expect(calls).toHaveLength(1)
    expect(git(remote, ["rev-parse", REF])).toBe(other)
  })
})
