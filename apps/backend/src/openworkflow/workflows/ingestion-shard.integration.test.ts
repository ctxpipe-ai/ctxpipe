import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { inArray } from "drizzle-orm"
import { initLogger } from "evlog"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { stringify } from "yaml"

import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  findStepCommit,
  ingestRefName,
  listStepFiles,
  pushIngestStep,
} from "../../domain/ingestion/ingest-refs.js"
import type {
  IngestRuntimeStep,
  IngestShardRuntime,
} from "../../domain/ingestion/ingest-shard-runtime.js"
import {
  addIngestModelCost,
  ingestUsageUsd,
} from "../../domain/ingestion/ingest-spend.js"
import { skillStepName } from "../../domain/ingestion/ingestion-plan.js"
import { generateObjectId } from "../../lib/id.js"
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
    | {
        tip: string
        ops: number
        rejects: number
        more: boolean
        cursor?: { at: number; of: number }
      }
  >,
  skill: { name: string; cursor?: { finder: string } } = {
    name: "classify-kind",
  },
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
      skill,
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

  const page = (at: number, of: number, more = true) => ({
    tip: "a".repeat(40),
    ops: 1,
    rejects: 0,
    more,
    cursor: { at, of },
  })
  const ownership = { name: "ownership", cursor: { finder: "ownership.mjs" } }

  it("runs a cursor skill for more than 20 pages while its cursor moves forward (CTX-1487)", async () => {
    const results = [
      ...Array.from({ length: 25 }, (_, i) => page(i + 1, 30)),
      page(30, 30, false),
    ]
    const state = await pages("services/d", results, ownership)
    expect(results).toEqual([])
    expect(state).toMatchObject({ ops: 26, partial: 0, partialRoots: [] })
  })

  it("stops a cursor skill as partial at a page whose cursor does not move forward", async () => {
    const results = [page(3, 10), page(3, 10), page(4, 10)]
    const state = await pages("services/e", results, ownership)
    // The third page does not run.
    expect(results).toHaveLength(1)
    expect(state).toMatchObject({ ops: 2, partial: 1 })
  })

  it("stops a cursor skill as partial when a page says more at the end of its input, changes the length of its input, or gives no cursor", async () => {
    for (const second of [
      page(10, 10),
      page(11, 10),
      page(4, 11),
      { tip: "a".repeat(40), ops: 1, rejects: 0, more: true },
    ]) {
      const results = [page(2, 10), second, page(5, 10, false)]
      const state = await pages("services/f", results, ownership)
      expect(results).toHaveLength(1)
      expect(state).toMatchObject({ partial: 1 })
    }
  })

  it("stops a cursor skill as partial when its last page changes the length of its input", async () => {
    const results = [page(2, 10), page(11, 11, false)]
    const state = await pages("services/h", results, ownership)
    expect(results).toEqual([])
    expect(state).toMatchObject({ ops: 2, partial: 1 })
  })

  it("goes on with a cursor whose pages cross a bundle change while the finder gives the same length, and else stops it as partial (CTX-1503)", async () => {
    // Page 1 is the cached page of the old bundle; page 2 runs the finder
    // of the new bundle.
    const same = [page(2, 10), page(6, 10), page(10, 10, false)]
    expect(await pages("services/i", same, ownership)).toMatchObject({
      ops: 3,
      partial: 0,
    })
    const changed = [page(2, 10), page(6, 12), page(10, 12, false)]
    expect(await pages("services/j", changed, ownership)).toMatchObject({
      ops: 2,
      partial: 1,
    })
    expect(changed).toHaveLength(1)
  })

  it("runs datasources-infra by its cursor, for more than 20 pages, to the end of its input (CTX-1487)", async () => {
    const results = [
      ...Array.from({ length: 25 }, (_, i) => page(i + 1, 30)),
      page(30, 30, false),
    ]
    const state = await pages(null, results, {
      name: "datasources-infra",
      cursor: { finder: "find-stores.mjs" },
    })
    expect(results).toEqual([])
    expect(state).toMatchObject({ ops: 26, partial: 0 })
  })

  it("stops a skill with no cursor as partial when its one page says more, and keeps the ops of the page (CTX-1487)", async () => {
    for (const name of ["classify-kind", "instruction-areas"]) {
      const results = [
        { tip: "b".repeat(40), ops: 3, rejects: 0, more: true },
        { tip: "c".repeat(40), ops: 1, rejects: 0, more: false },
      ]
      const state = await pages(null, results, { name })
      // The second page does not run.
      expect(results).toHaveLength(1)
      expect(state).toMatchObject({ tip: "b".repeat(40), ops: 3, partial: 1 })
    }
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
    find: (ref, step, since) =>
      findStepCommit({ remote: { url: remote }, ref, runId: RUN, step, since }),
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
    cursor?: { finder: string },
    model?: {
      orgId: string
      /** The step outputs that OpenWorkflow saves. */
      outputs: unknown[]
      /** The worker stops after the step body, before the output is saved. */
      stopBeforeSave?: boolean
    },
  ) {
    return withLogger(createLogger({ test: "skill-pages-twice" }), () =>
      runSkillPages({
        step: async (_name, fn) => {
          const output = await fn()
          if (model?.stopBeforeSave) throw new Error("The worker stopped")
          model?.outputs.push(output)
          return output
        },
        run: {
          orgId: model?.orgId ?? "org_fixture",
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
        skill: {
          name: skill,
          scope: "root",
          run: model ? "model" : "script",
          cursor,
        },
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

  /**
   * A cursor skill whose finder gives 5 inputs, and whose pages each write a
   * new file, say `more`, and give `cursor.at` 1.
   */
  function stuckCursorSandbox() {
    const calls: Array<{ name: string; cursor?: { finder: string } }> = []
    const runtime = {
      runStep: async (step: { name: string; cursor?: { finder: string } }) => {
        calls.push({ name: step.name, cursor: step.cursor })
        const out = join(dir, `step-${++count}`)
        const path = `knowledge/services/page-${calls.length}.md`
        mkdirSync(dirname(join(out, "files", path)), { recursive: true })
        writeFileSync(join(out, "files", path), service(`Page ${calls.length}`))
        writeFileSync(
          join(out, "patch.json"),
          JSON.stringify({
            ops: [{ op: "create", path }],
            more: true,
            cursor: { at: 1 },
          }),
        )
        return {
          tar: new Uint8Array(
            execFileSync("tar", ["-C", out, "-cf", "-", "."], { env: GIT_ENV }),
          ),
          inputs: 5,
        }
      },
    } as unknown as IngestShardRuntime
    return { runtime, calls }
  }

  const workspace = (): IngestionShardWorkspace => ({
    workspaceId: WS,
    tip: null,
    ops: 0,
    rejects: 0,
    partial: 0,
    partialRoots: [],
  })

  it("stops a cursor skill at a page whose cursor does not move, and keeps the cursor in the step commit (CTX-1487)", async () => {
    freshRemote()
    const state = workspace()
    const { runtime, calls } = stuckCursorSandbox()
    const cursor = { finder: "ownership.mjs" }
    await runSkill("ownership", state, runtime, cursor)
    // The runtime runs the finder of each page; page 2 repeats the cursor.
    expect(calls).toEqual([
      { name: skillStepName(ROOT, "ownership", WS, 1), cursor },
      { name: skillStepName(ROOT, "ownership", WS, 2), cursor },
    ])
    expect(state).toMatchObject({ ops: 2, partial: 1, partialRoots: [ROOT] })
    expect(git(remote, ["log", "-1", "--format=%B", REF])).toContain(
      "Ctxpipe-Cursor: 1 5",
    )
    // A resumed step reads the cursor from its commit.
    await expect(
      broker.find(REF, skillStepName(ROOT, "ownership", WS, 1), pinned),
    ).resolves.toMatchObject({ cursor: { at: 1, of: 5 }, more: true })
  })

  describe("the cost of a model step (CTX-1522)", () => {
    const orgIds: string[] = []
    const events: Array<Record<string, unknown>> = []

    beforeAll(() => {
      initDb(process.env.DATABASE_URL ?? "")
    })

    /** Each test has its own org, so that no recorded cost of another test counts. */
    async function newOrg(): Promise<string> {
      const orgId = generateObjectId("org")
      orgIds.push(orgId)
      await getSystemDb()
        .insert(organizations)
        .values({
          id: orgId,
          name: "Model cost",
          slug: `cost-${orgId.slice(-8)}`,
          createdAt: new Date(),
        })
      return orgId
    }

    afterEach(() => {
      events.length = 0
      initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    })

    afterAll(async () => {
      await getSystemDb()
        .delete(organizations)
        .where(inArray(organizations.id, orgIds))
      await closeDb()
    })

    /**
     * A model step: the model proxy records `usd` for each attempt, and
     * OpenCode reports its tokens at its own fixed prices.
     */
    function modelSandbox(
      orgId: string,
      usd: number,
      options: { failFirst?: boolean } = {},
    ) {
      const { runtime: staging } = sandbox({
        "knowledge/services/a.md": service("A"),
      })
      let attempts = 0
      const runtime = {
        runStep: async (step: IngestRuntimeStep) => {
          attempts++
          if (usd > 0)
            await addIngestModelCost(
              { orgId, runId: RUN, shard: 0, step: step.name },
              usd,
            )
          if (options.failFirst && attempts === 1)
            throw new Error("The ingest step reached its time limit")
          return {
            ...(await staging.runStep(step)),
            usage: { inputTokens: 100_000, outputTokens: 10_000 },
          }
        },
      } as unknown as IngestShardRuntime
      return { runtime, attempts: () => attempts }
    }

    function logEvents() {
      initLogger({
        pretty: false,
        silent: true,
        env: { service: "ctxpipe-backend-test" },
        drain: (ctx) => {
          events.push(ctx.event as Record<string, unknown>)
        },
      })
    }

    it("is the recorded cost of the calls of all attempts, also of a failed attempt", async () => {
      freshRemote()
      const orgId = await newOrg()
      const { runtime, attempts } = modelSandbox(orgId, 0.25, {
        failFirst: true,
      })
      const outputs: unknown[] = []
      await runSkill("classify-kind", workspace(), runtime, undefined, {
        orgId,
        outputs,
      })
      expect(attempts()).toBe(2)
      expect(outputs).toEqual([
        expect.objectContaining({
          usage: expect.objectContaining({ costUsd: 0.5 }),
        }),
      ])
    }, 30_000)

    it("is 0 with a log event when the model proxy recorded no cost, not the fixed prices of the tokens", async () => {
      freshRemote()
      logEvents()
      const orgId = await newOrg()
      const { runtime } = modelSandbox(orgId, 0)
      const outputs: Array<{ usage?: { costUsd?: number } }> = []
      await runSkill("classify-kind", workspace(), runtime, undefined, {
        orgId,
        outputs,
      })
      const usage = outputs[0]?.usage
      expect(usage).toMatchObject({
        inputTokens: 100_000,
        outputTokens: 10_000,
        costUsd: 0,
      })
      if (!usage) throw new Error("The step output has no usage")
      expect(
        ingestUsageUsd({ inputTokens: 0, outputTokens: 0, ...usage }),
      ).toBe(0)
      expect(
        events.filter((e) => e.step === "ingestion-v2.model-cost-missing"),
      ).toHaveLength(1)
    }, 30_000)

    it("keeps the cost of a step whose worker stopped before the step output was saved", async () => {
      freshRemote()
      const state = workspace()
      const orgId = await newOrg()
      const stopped = modelSandbox(orgId, 0.25)
      await expect(
        runSkill("classify-kind", state, stopped.runtime, undefined, {
          orgId,
          outputs: [],
          stopBeforeSave: true,
        }),
      ).rejects.toThrow("The worker stopped")
      // The next worker runs the step again. It finds the pushed commit, so
      // it makes no call, and it counts the calls of the stopped worker.
      const next = modelSandbox(orgId, 0.25)
      const outputs: unknown[] = []
      await runSkill("classify-kind", state, next.runtime, undefined, {
        orgId,
        outputs,
      })
      expect(next.attempts()).toBe(0)
      expect(outputs).toEqual([
        expect.objectContaining({
          usage: expect.objectContaining({ costUsd: 0.25 }),
        }),
      ])
    }, 30_000)
  })

  it("continues from the other execution's commit, with no refusal and no partial step", async () => {
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
    const { runtime, calls } = sandbox({
      "knowledge/services/deps.md": service("Deps"),
    })
    await runSkill("dependencies", state, runtime)
    expect(state).toMatchObject({ partial: 0, ops: 3 })
    expect(calls).toHaveLength(1)
    expect(git(remote, ["rev-parse", REF])).toBe(state.tip)
    expect(git(remote, ["rev-parse", `${state.tip}^`])).toBe(other.sha)
  })

  it("takes each step that the other execution pushed ahead of it, with no model run", async () => {
    freshRemote()
    const state = workspace()
    await runSkill(
      "classify-kind",
      state,
      sandbox({ "knowledge/services/a.md": service("A") }).runtime,
    )
    const apis = await otherExecutionPushes("apis", state.tip ?? "", {
      "knowledge/services/api.md": service("Api"),
    })
    const deps = await otherExecutionPushes("dependencies", apis.sha, {
      "knowledge/services/deps.md": service("Deps"),
    })
    const { runtime, calls } = sandbox({
      "knowledge/services/none.md": service("None"),
    })
    await runSkill("apis", state, runtime)
    expect(state.tip).toBe(apis.sha)
    await runSkill("dependencies", state, runtime)
    expect(state).toMatchObject({ partial: 0, ops: 3, tip: deps.sha })
    expect(calls).toHaveLength(0)
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
