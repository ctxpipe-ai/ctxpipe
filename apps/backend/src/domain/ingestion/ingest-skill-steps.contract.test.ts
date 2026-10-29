import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { stringify } from "yaml"

import {
  type IngestionShardWorkspace,
  runSkillPages,
  type SkillStepBroker,
} from "../../openworkflow/workflows/ingestion-shard.js"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import { hydrateKnowledgeTree } from "../workspaces/hydrate.js"
import { stepContextIndex } from "./context-index.js"
import { ingestOpenCodeConfig } from "./ingest-opencode.js"
import { collectIngestStep } from "./ingest-prepare.js"
import {
  findStepCommit,
  type IngestRemote,
  ingestRefName,
  ingestRunRefTip,
  listStepFiles,
  pushIngestAssemble,
  pushIngestStep,
} from "./ingest-refs.js"
import { dockerRootExec, type RootExec, runAsRoot } from "./ingest-root.js"
import {
  ingestAgentEnv,
  ingestSkillArguments,
  prepareIngestShard,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import type {
  IngestDestination,
  IngestShardRuntime,
  IngestStepUsage,
} from "./ingest-shard-runtime.js"
import { type IngestSkillPlan, plannedIngestSkills } from "./ingestion-plan.js"
import { gitSource } from "./patch-validator.js"
import { runGit } from "./run-git.js"
import { readIngestSkillBundle } from "./skill-bundle.js"

/*
 * Contract (Docker): one ingestion run of each skill through the real host
 * path (`runSkillPages`: the step index at the step base, the root-to-file
 * map from the step commits, paging, the patch validator, and the push), in
 * a real chat sandbox image, in the run order of ADR-052 section 6: the
 * repository step on the assembled ref; the root steps on shard ref 0 from
 * the run base; assemble; then the repository-wide steps on the assembled
 * ref. The Workspace repository is a bare repository in the container; the
 * host pushes to it and reads it through git's `ext::` transport with
 * `docker exec`, and the sandbox fetches the refs from it. A model skill runs
 * `opencode run` against a deterministic model stub in the container: the
 * stub returns a fixed list of tool calls (the skill's scripts with the
 * step's arguments, and fixed agent writes).
 *
 * Run: pnpm --filter @ctxpipe/backend exec vitest run
 *   src/domain/ingestion/ingest-skill-steps.contract.test.ts
 */

const SOURCE_URL = "https://github.com/example-org/shop"
// The source file of SOURCE_URL in the Workspace: the value of `sources`.
const SOURCE_PATH = "sources/github/example-org/shop.md"
const WORKSPACE_ID = "ws_steps"
const STUB_PORT = 47813
const STUB_CALLS = "/tmp/stub-calls.json"
const AGENT_WRITE = "/tmp/agent-write.mjs"
const AGENT_CLAIM = "/tmp/agent-claim.mjs"
const RUN_ID = "run_contract"
const AUTHOR_TIME = "2026-10-01T00:00:00.000Z"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
}

const pkg = (name: string, extra: object = {}) =>
  `${JSON.stringify({ name, version: "1.0.0", ...extra }, null, 2)}\n`
const front = (attributes: object, body: string) =>
  `---\n${stringify(attributes)}---\n${body}`

/** One source repository for every skill of the run. */
const SOURCE: Record<string, string> = {
  "package.json": pkg("shop", { private: true }),
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
  "apps/api/package.json": pkg("api", {
    private: true,
    dependencies: { hono: "^4.0.0", zod: "^3.23.0" },
  }),
  "apps/api/src/index.ts": [
    'import { Hono } from "hono"',
    "const app = new Hono()",
    'app.get("/invoices", (c) => c.json([]))',
    "export async function bill() {",
    '  return fetch("http://billing.internal:8080/invoices")',
    "}",
    "export default app",
    "",
  ].join("\n"),
  "apps/web/package.json": pkg("web", {
    private: true,
    dependencies: { next: "15.0.0", pg: "^8.0.0" },
  }),
  "apps/web/src/db.ts":
    'import { Pool } from "pg"\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL })\n',
  "docs/adr/0001-use-postgres.md":
    "# 1. Use Postgres\n\nDate: 2026-08-01\n\n## Status\n\nAccepted\n\n## Decision\n\nThe web app keeps its data in Postgres.\n",
  ".github/CODEOWNERS": "/apps/api/ @example-org/payments\n",
  "AGENTS.md":
    "# Agents\n\nUse Vitest for unit tests.\nName test files with the suffix .test.ts.\nMock only the network.\nKeep a test next to the code it tests.\n",
  "src/a.test.ts": 'import { it } from "vitest"\n',
  "src/b.test.ts": 'import { it } from "vitest"\n',
  "lib/c.test.ts": 'import { it } from "vitest"\n',
}

const CODEBASE = "knowledge/codebases/shop.md"
const API_SERVICE = "knowledge/services/api.md"
const BILLING = "knowledge/services/billing.md"
const WEB_APP = "knowledge/apps/web.md"

/** The pinned revision of the Workspace: a human file and no file of the run. */
const CONTEXT: Record<string, string> = {
  "README.md": "# Context\n",
  [BILLING]: front(
    { kind: "Service", name: "Billing", summary: "The billing service." },
    "# Billing\n\nThe team wrote this.\n",
  ),
}

/** The planned roots of the run, as `resolveDiscoveredRoots` gives them. */
const ROOTS = [
  { path: ".", manifests: ["package.json"], evidence: ["pnpm-workspace.yaml"] },
  {
    path: "apps/api",
    manifests: ["apps/api/package.json"],
    evidence: ["pnpm-workspace.yaml"],
  },
  {
    path: "apps/web",
    manifests: ["apps/web/package.json"],
    evidence: ["pnpm-workspace.yaml"],
  },
]

/*
 * An OpenAI-compatible stub. It reads the calls of the current step on each
 * request; while the request has fewer tool results than calls, it asks for
 * the next call.
 */
const STUB_MODEL = `
import http from "node:http"
import { readFileSync } from "node:fs"
http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    const calls = JSON.parse(readFileSync(${JSON.stringify(STUB_CALLS)}, "utf8"))
    const parsed = JSON.parse(body)
    const done = parsed.messages.filter((m) => m.role === "tool").length
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta, finish) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n"
    const next = calls[done]
    if (next) {
      res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + done, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: next, description: "Run a step command" }) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\\n\\n")
      return
    }
    const usage = "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "stub", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + "\\n\\n"
    res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + usage + "data: [DONE]\\n\\n")
  })
}).listen(${STUB_PORT}, "127.0.0.1")
`

/** The agent's write: stage a path, then write base64 text to the staged copy. */
const AGENT_WRITE_SCRIPT = `
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
const [path, text] = process.argv.slice(2)
const out = execFileSync("ctxpipe-stage", [path]).toString().trim()
writeFileSync(out.split(" ").pop(), Buffer.from(text, "base64").toString("utf8"))
`

/** The agent's additive edit: stage a path, then add one claim item (base64 YAML) to its claims. */
const AGENT_CLAIM_SCRIPT = `
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
const [path, claim] = process.argv.slice(2)
const staged = execFileSync("ctxpipe-stage", [path]).toString().trim().split(" ").pop()
const text = readFileSync(staged, "utf8")
const item = Buffer.from(claim, "base64").toString("utf8")
writeFileSync(staged, /^claims:\\n/m.test(text)
  ? text.replace(/^claims:\\n/m, "claims:\\n" + item)
  : text.replace(/\\n---\\n/, "\\nclaims:\\n" + item + "---\\n"))
`

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** A bash call that writes one context file as the agent. */
const agentWrite = (path: string, text: string) =>
  `node ${AGENT_WRITE} ${quote(path)} ${Buffer.from(text).toString("base64")}`

let host: string
let handle: SandboxHandle
let root: RootExec
let provider: ReturnType<typeof dockerSandbox>
let agentEnv: Record<string, string>
let source: { dir: string; sha: string }
let pinned: string
let remote: IngestRemote
let view: string
let broker: SkillStepBroker
let runtime: IngestShardRuntime
let destination: IngestDestination
let skills: IngestSkillPlan[]
/** The step names in the order the host ran them. */
const ran: string[] = []
/** The usage that `runIngestShardStep` read from each model step. */
const modelUsage: Array<IngestStepUsage | undefined> = []

const ASSEMBLED = ingestRefName({ runId: RUN_ID, workspaceId: WORKSPACE_ID })
const SHARD = ingestRefName({
  runId: RUN_ID,
  workspaceId: WORKSPACE_ID,
  shard: "0",
})
const fresh = (): IngestionShardWorkspace => ({
  workspaceId: WORKSPACE_ID,
  tip: null,
  ops: 0,
  rejects: 0,
  partial: 0,
  partialRoots: [],
})
/** The assembled ref: the repository step, then assemble and the repository-wide steps. */
const assembled = fresh()
/** Shard ref 0: the root steps, from the run base. */
const shard = fresh()
let runBase: string

/** The same commit on the host and in the container: fixed dates and author. */
function hostRepo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = mkdtempSync(join(host, "repo-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    }).trim()
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "seed")
  return { dir, sha: git("rev-parse", "HEAD") }
}

async function containerRepo(
  path: string,
  files: Record<string, string>,
): Promise<string> {
  const work = `${path}.work`
  for (const [file, content] of Object.entries(files)) {
    await handle.process.exec(`mkdir -p ${quote(dirname(`${work}/${file}`))}`)
    await handle.fs.write(`${work}/${file}`, content)
  }
  const result = await handle.process.exec(
    `cd ${work} && git init -q -b main && git add -A && git commit -q -m seed && git clone -q --bare ${work} ${path} && git -C ${path} config uploadpack.allowAnySHA1InWant true && git rev-parse HEAD`,
    { env: GIT_ENV },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** The host's view of the Workspace repository: its run refs. */
function show(tip: string, path: string): string {
  return execFileSync("git", ["-C", view, "show", `${tip}:${path}`], {
    encoding: "utf8",
  })
}

async function refresh(): Promise<void> {
  await runGit(
    view,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      remote.url,
      "+refs/ctxpipe/*:refs/ctxpipe/*",
    ],
    { env: remote.env },
  )
}

/** The paths that changed on a ref from `from` to `to`. */
function changed(from: string, to: string): string[] {
  return execFileSync(
    "git",
    ["-C", view, "diff-tree", "-r", "--name-only", "--no-renames", from, to],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort()
}

/**
 * Run one skill through the host path (`runSkillPages`) and return the
 * paths that its pages changed on the ref.
 */
async function hostSkill(input: {
  skill: string
  scope: IngestSkillPlan["scope"]
  root: string | null
  /** Model steps: the bash commands that the stub agent runs. */
  calls?: (args: string) => string[]
  ref: string
  runBase: string
  state: IngestionShardWorkspace
}) {
  const plan = skills.find(
    (s) => s.name === input.skill && s.scope === input.scope,
  )
  if (!plan)
    throw new Error(`The plan has no ${input.scope} step of ${input.skill}`)
  const args = ingestSkillArguments({
    root: input.root,
    sourceUrl: SOURCE_URL,
    sourcePath: SOURCE_PATH,
  })
  await handle.fs.write(
    STUB_CALLS,
    JSON.stringify(input.calls ? input.calls(args) : []),
  )
  const before = input.state.tip ?? input.runBase
  const counts = { rejects: input.state.rejects, partial: input.state.partial }
  await runSkillPages({
    step: async (name, fn) => {
      ran.push(name)
      return fn()
    },
    run: {
      runId: RUN_ID,
      bundle: "ingest-contract",
      source: {
        kind: "github" as const,
        url: SOURCE_URL,
        githubConnectionId: "con_contract",
        sha: source.sha,
        repositoryId: null,
      },
      authorTime: AUTHOR_TIME,
      roots: ROOTS,
    },
    broker,
    runtime,
    root: input.root,
    skill: plan,
    destination,
    ref: input.ref,
    runBase: input.runBase,
    state: input.state,
  })
  // The validator rejected nothing, and no step is partial.
  expect({
    rejects: input.state.rejects,
    partial: input.state.partial,
  }).toEqual(counts)
  const tip = input.state.tip ?? before
  await refresh()
  return {
    tip,
    paths: changed(before, tip),
    show: (path: string) => show(tip, path),
  }
}

/** A bash call that adds one claim to the staged copy of a context file, as the agent. */
const agentClaim = (path: string, claim: object) =>
  `node ${AGENT_CLAIM} ${quote(path)} ${Buffer.from(
    stringify([claim]).replace(/^/gm, "  ").replace(/ +$/, ""),
  ).toString("base64")}`

beforeAll(async () => {
  host = mkdtempSync(join(tmpdir(), "ingest-skill-steps-"))
  source = hostRepo(SOURCE)
  const bundle = await readIngestSkillBundle()
  skills = [
    ...plannedIngestSkills(bundle.skills, "first"),
    ...plannedIngestSkills(bundle.skills, "root"),
    ...plannedIngestSkills(bundle.skills, "repository"),
  ]
  provider = dockerSandbox({ image: workspaceChatDockerImage() })
  handle = await provider.create({
    id: `ingest-steps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })
  root = dockerRootExec(handle.id)
  await runAsRoot(root, "git config --system --add safe.directory '*'")
  const sourceSha = await containerRepo("/tmp/remotes/source.git", SOURCE)
  expect(sourceSha).toBe(source.sha)
  pinned = await containerRepo("/tmp/remotes/context.git", CONTEXT)
  remote = {
    url: `ext::docker exec -i ${handle.id} %S /tmp/remotes/context.git`,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.ext.allow",
      GIT_CONFIG_VALUE_0: "always",
    },
  }
  view = mkdtempSync(join(host, "view-"))
  await runGit(view, ["init", "--quiet", "--bare"])
  await runGit(
    view,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      remote.url,
      "+refs/heads/main:refs/heads/main",
    ],
    { env: remote.env },
  )
  destination = {
    workspaceId: WORKSPACE_ID,
    url: "https://github.com/example-org/context",
    githubConnectionId: "con_contract",
    generation: 1,
    pinnedRevision: pinned,
    repositoryId: null,
    sourcePath: SOURCE_PATH,
  }
  const job = { runId: RUN_ID, workspaceId: WORKSPACE_ID }
  broker = {
    find: (ref, step) => findStepCommit({ remote, ref, runId: RUN_ID, step }),
    listFiles: (pinnedRevision, tip) =>
      listStepFiles({ remote, runId: RUN_ID, pinnedRevision, tip }),
    push: (push) => pushIngestStep({ ...push, job, remote }),
    runTip: (ref, given) =>
      ingestRunRefTip({ remote, ref, runId: RUN_ID, given }),
    ...gitSource(source.dir, source.sha),
  }
  // The step index of the host path: the projection at the pinned revision
  // (the human Billing file), changed by the run's step commits.
  const projection = hydrateKnowledgeTree({
    workspaceId: WORKSPACE_ID,
    files: Object.entries(CONTEXT).map(([path, content]) => ({
      path,
      content,
    })),
  }).units.map((unit) => ({
    path: unit.path,
    kind: unit.kind ?? null,
    links: unit.links,
  }))
  const indexDir = mkdtempSync(join(host, "index-"))
  await runGit(indexDir, ["init", "--quiet", "--bare"])
  const index = stepContextIndex({
    workspaceId: WORKSPACE_ID,
    pinnedRevision: pinned,
    sourcePath: SOURCE_PATH,
    repoDir: indexDir,
    projection: async () => projection,
    fetch: async (what, into) => {
      await runGit(
        indexDir,
        ["fetch", "--quiet", "--no-tags", "--", remote.url, `+${what}:${into}`],
        { env: remote.env },
      )
    },
  })
  runtime = {
    ensure: async () => undefined,
    discoverRoots: async () => null,
    runStep: async (step) => {
      const { usage } = await runIngestShardStep(root, {
        step,
        agentEnv,
        remote: "/tmp/remotes/context.git",
        sourceUrl: SOURCE_URL,
        sourcePath: SOURCE_PATH,
        index: (await index.at(step.baseCommit, step.fetchRef)).json,
      })
      if (step.run === "model") modelUsage.push(usage)
      return { tar: await collectIngestStep(handle, root) }
    },
  }

  agentEnv = await ingestAgentEnv(root, {
    modelProxyUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
  })
  await prepareIngestShard(handle, root, {
    bundle,
    opencodeConfig: ingestOpenCodeConfig({
      modelBase: "stub",
      models: [],
      skills: bundle.skills,
      proxyAddsCredentials: true,
      toolBridgeUrl: "http://127.0.0.1:9/tool-bridge",
    }),
    agentEnv,
    source: { url: "/tmp/remotes/source.git", sha: source.sha, blobless: true },
    contexts: [{ workspaceId: WORKSPACE_ID, url: "/tmp/remotes/context.git" }],
    now: new Date("2026-10-01T00:00:00Z"),
  })
  await handle.fs.write(STUB_CALLS, "[]")
  await handle.fs.write(AGENT_WRITE, AGENT_WRITE_SCRIPT)
  await handle.fs.write(AGENT_CLAIM, AGENT_CLAIM_SCRIPT)
  await handle.fs.write("/tmp/stub-model.mjs", STUB_MODEL)
  await handle.process.exec(
    "chmod 644 /tmp/stub-calls.json /tmp/agent-write.mjs /tmp/agent-claim.mjs && nohup node /tmp/stub-model.mjs >/tmp/stub.out 2>&1 &",
  )
  const ready = await handle.process.exec(
    `for i in $(seq 1 50); do node -e "require('net').connect(${STUB_PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && exit 0; sleep 0.2; done; exit 1`,
  )
  if (ready.exitCode !== 0) throw new Error("The model stub did not start")
}, 600_000)

afterAll(async () => {
  if (handle) await provider.destroy({ id: handle.id })
  rmSync(host, { recursive: true, force: true })
})

describe("one ingestion run of each skill through the host path (Docker)", () => {
  it("repository: the first step writes the repository unit on the assembled ref", async () => {
    const step = await hostSkill({
      skill: "repository",
      scope: "first",
      root: null,
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    expect(step.paths).toEqual([CODEBASE])
    const unit = step.show(CODEBASE)
    expect(unit).toContain("kind: Repository")
    expect(unit).toContain("root: .")
    expect(unit).toContain("has the root `apps/api`")
    runBase = step.tip
  }, 600_000)

  it("classify-kind: each root step writes the root's file, linked to the repository unit, with the host root", async () => {
    for (const path of ["apps/api", "apps/web"])
      await hostSkill({
        skill: "classify-kind",
        scope: "root",
        root: path,
        calls: (args) => [
          `node /ctxpipe/skills/classify-kind/scripts/classify-kind.mjs ${args}`,
        ],
        ref: SHARD,
        runBase,
        state: shard,
      })
    const tip = shard.tip ?? ""
    expect(changed(runBase, tip)).toEqual([WEB_APP, API_SERVICE].sort())
    const api = show(tip, API_SERVICE)
    // The index at the step base held the repository unit of the first step.
    expect(api).toContain("predicate: IMPLEMENTED_IN")
    expect(api).toContain("to: ../codebases/shop.md")
    expect(api).toContain("root: apps/api")
    expect(show(tip, WEB_APP)).toContain("root: apps/web")
  }, 600_000)

  it("apis: a root step writes the API, its operation, and EXPOSES_API on the root's Service", async () => {
    const plan = {
      root: "apps/api",
      service: API_SERVICE,
      apis: [
        {
          name: "Invoices API",
          operations: [{ method: "GET", path: "/invoices" }],
        },
      ],
    }
    const step = await hostSkill({
      skill: "apis",
      scope: "root",
      root: "apps/api",
      calls: (args) => [
        `node /ctxpipe/skills/apis/scripts/find-apis.mjs ${args}`,
        `printf %s ${quote(JSON.stringify(plan))} > /ctxpipe/home/apis-plan.json`,
        `node /ctxpipe/skills/apis/scripts/write-apis.mjs ${args} --plan /ctxpipe/home/apis-plan.json`,
      ],
      ref: SHARD,
      runBase,
      state: shard,
    })
    expect(step.paths).toContain("knowledge/apis/invoices-api.md")
    expect(step.paths.some((p) => p.startsWith("knowledge/operations/"))).toBe(
      true,
    )
    expect(step.show("knowledge/apis/invoices-api.md")).toContain(
      "predicate: HAS_OPERATION",
    )
    expect(step.show(API_SERVICE)).toContain("predicate: EXPOSES_API")
  }, 600_000)

  it("dependencies: a root step writes DEPENDS_ON from the root's Service to the human billing Service", async () => {
    const resolve = [
      "const fs = require('node:fs')",
      "const scan = JSON.parse(fs.readFileSync('/ctxpipe/home/scan.json', 'utf8'))",
      "const call = scan.candidates.find((c) => c.target.text.endsWith('/invoices'))",
      `fs.writeFileSync('/ctxpipe/out/resolutions.json', JSON.stringify({ resolutions: [{ id: call.id, kind: 'service', path: '${BILLING}' }] }))`,
    ].join(";")
    const step = await hostSkill({
      skill: "dependencies",
      scope: "root",
      root: "apps/api",
      calls: (args) => [
        `node /ctxpipe/skills/dependencies/scripts/scan.mjs ${args} > /ctxpipe/home/scan.json`,
        `node -e ${quote(resolve)}`,
        `node /ctxpipe/skills/dependencies/scripts/apply.mjs ${args} --resolutions /ctxpipe/out/resolutions.json`,
      ],
      ref: SHARD,
      runBase,
      state: shard,
    })
    expect(step.paths).toEqual([API_SERVICE])
    const text = step.show(API_SERVICE)
    expect(text).toContain("predicate: DEPENDS_ON")
    expect(text).toContain("to: billing.md")
  }, 600_000)

  it("assemble: merges the shard tip on the run base into the assembled ref", async () => {
    const result = await pushIngestAssemble({
      job: { runId: RUN_ID, workspaceId: WORKSPACE_ID },
      pinnedRevision: runBase,
      shards: [{ shard: "0", tip: shard.tip ?? "" }],
      oldTip: runBase,
      opsBefore: assembled.ops,
      remote,
      commit: {
        step: `assemble:${WORKSPACE_ID}`,
        bundle: "ingest-contract",
        authorTime: new Date(AUTHOR_TIME),
      },
    })
    assembled.tip = result.sha
    assembled.ops += result.ops
    await refresh()
    expect(changed(runBase, result.sha)).toEqual(
      changed(runBase, shard.tip ?? ""),
    )
  }, 600_000)

  it("libraries: the repository-wide script step writes library files and USES_LIBRARY from the root's Service", async () => {
    const step = await hostSkill({
      skill: "libraries",
      scope: "repository",
      root: null,
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    expect(step.paths).toContain(API_SERVICE)
    expect(step.paths.some((p) => p.startsWith("knowledge/libraries/"))).toBe(
      true,
    )
    expect(step.show(API_SERVICE)).toContain("predicate: USES_LIBRARY")
  }, 600_000)

  it("ownership: the repository-wide script step writes the team file with OWNS to the root's Service", async () => {
    const step = await hostSkill({
      skill: "ownership",
      scope: "repository",
      root: null,
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    const team = step.paths.find((p) => p.startsWith("knowledge/teams/"))
    expect(team).toBeDefined()
    const text = step.show(team ?? "")
    expect(text).toContain("predicate: OWNS")
    expect(text).toContain("to: ../services/api.md")
  }, 600_000)

  it("datasources-infra: the repository-wide step writes the shared store file and READS_FROM from the App", async () => {
    const store = "knowledge/databases/postgresql-for-web.md"
    // The agent never writes a host field (generated_by, sources, root).
    const storeText = front(
      {
        kind: "Database",
        name: "PostgreSQL for web",
        summary: "Primary relational store of the web app.",
      },
      "# PostgreSQL for web\n\nRole: primary store. The web app reads it through the `pg` driver.\n",
    )
    const step = await hostSkill({
      skill: "datasources-infra",
      scope: "repository",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/datasources-infra/scripts/find-stores.mjs ${args}`,
        agentWrite(store, storeText),
        agentClaim(WEB_APP, {
          to: "../databases/postgresql-for-web.md",
          predicate: "READS_FROM",
          evidence: { path: "apps/web/package.json", kind: "script" },
        }),
      ],
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    expect(step.paths).toEqual([store, WEB_APP].sort())
    expect(step.show(WEB_APP)).toContain("predicate: READS_FROM")
    expect(step.show(store)).toContain("kind: Database")
  }, 600_000)

  it("decisions: the repository-wide step writes one Decision file for the ADR", async () => {
    const write = [
      "const fs = require('node:fs')",
      "const { execFileSync } = require('node:child_process')",
      "const out = JSON.parse(fs.readFileSync('/ctxpipe/home/decisions.json', 'utf8'))",
      "for (const d of out.decisions) {",
      "  const staged = execFileSync('ctxpipe-stage', [d.target]).toString().trim().split(' ').pop()",
      "  const claims = d.influences.map((to) => ({ to, predicate: 'INFLUENCES', evidence: { path: d.path, kind: 'script' } }))",
      "  const yaml = ['---', 'kind: Decision', 'name: ' + JSON.stringify(d.name), 'summary: \"The web app keeps its data in Postgres.\"', ...(claims.length ? ['claims:', ...claims.map((c) => '  - to: ' + c.to + '\\n    predicate: ' + c.predicate + '\\n    evidence:\\n      path: ' + c.evidence.path + '\\n      kind: script')] : []), '---'].join('\\n')",
      "  fs.writeFileSync(staged, yaml + '\\n\\n# ' + d.name + '\\n\\n**Status:** Accepted\\n**Source:** `' + d.path + '`\\n\\n## Decision\\n\\nThe web app keeps its data in Postgres.\\n')",
      "}",
    ].join("\n")
    const step = await hostSkill({
      skill: "decisions",
      scope: "repository",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/decisions/scripts/decisions.mjs ${args} > /ctxpipe/home/decisions.json`,
        `node -e ${quote(write)}`,
        `node /ctxpipe/skills/decisions/scripts/decisions.mjs ${args} --check`,
      ],
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    expect(step.paths).toHaveLength(1)
    const [decision] = step.paths
    expect(decision?.startsWith("knowledge/decisions/")).toBe(true)
    const text = step.show(decision ?? "")
    expect(text).toContain("kind: Decision")
    expect(text).toContain("**Source:** `docs/adr/0001-use-postgres.md`")
  }, 600_000)

  it("instruction-areas: the repository-wide step writes a shared area file and FOLLOWS from the repository unit", async () => {
    const doc = (quote: string) => [{ path: "AGENTS.md", quote }]
    const proposal = {
      areas: [
        {
          slug: "unit-testing",
          summary: "How the code is tested.",
          rules: [
            {
              key: "test-framework",
              value: "vitest",
              core: true,
              text: "Use vitest for unit tests.",
              documents: doc("Use Vitest for unit tests."),
            },
            {
              key: "file-naming",
              value: "test-suffix",
              text: "Name test files with the suffix .test.ts.",
              documents: doc("Name test files with the suffix .test.ts."),
            },
            {
              key: "mocking",
              value: "network-only",
              text: "Mock only the network.",
              documents: doc("Mock only the network."),
            },
            {
              key: "layout",
              value: "next-to-code",
              text: "Keep a test next to the code it tests.",
              documents: doc("Keep a test next to the code it tests."),
            },
            {
              key: "imports",
              value: "vitest",
              text: "Tests import from vitest.",
              pattern: 'from "vitest"',
            },
          ],
        },
      ],
    }
    const step = await hostSkill({
      skill: "instruction-areas",
      scope: "repository",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/instruction-areas/scripts/documents.mjs ${args}`,
        `printf %s ${quote(JSON.stringify(proposal))} > /ctxpipe/out/proposal.json`,
        `node /ctxpipe/skills/instruction-areas/scripts/instruction-areas.mjs ${args} --proposal /ctxpipe/out/proposal.json --now 2026-10-01T00:00:00Z`,
      ],
      ref: ASSEMBLED,
      runBase: pinned,
      state: assembled,
    })
    expect(step.paths).toEqual(
      [CODEBASE, "knowledge/instructions/unit-testing.md"].sort(),
    )
    const unit = step.show(CODEBASE)
    expect(unit).toContain("predicate: FOLLOWS")
    expect(unit).toContain("to: ../instructions/unit-testing.md")
  }, 600_000)

  it("ran the steps in the plan order, one page each, and a replay finds each commit with no new run", async () => {
    expect(ran).toEqual([
      `skill:repository:repository:${WORKSPACE_ID}`,
      expect.stringMatching(/^skill:apps\/api~[0-9a-f]{12}:classify-kind:/),
      expect.stringMatching(/^skill:apps\/web~[0-9a-f]{12}:classify-kind:/),
      expect.stringMatching(/^skill:apps\/api~[0-9a-f]{12}:apis:/),
      expect.stringMatching(/^skill:apps\/api~[0-9a-f]{12}:dependencies:/),
      `skill:repository:libraries:${WORKSPACE_ID}`,
      `skill:repository:ownership:${WORKSPACE_ID}`,
      `skill:repository:datasources-infra:${WORKSPACE_ID}`,
      `skill:repository:decisions:${WORKSPACE_ID}`,
      `skill:repository:instruction-areas:${WORKSPACE_ID}`,
    ])
    // Each model step reads its usage from the JSON events of the real
    // `opencode run`. The stub model has no price, so no cost is known.
    expect(modelUsage.length).toBeGreaterThan(0)
    for (const usage of modelUsage) {
      expect(usage).toBeDefined()
      expect(usage?.inputTokens).toBeGreaterThanOrEqual(100)
      expect(usage?.outputTokens).toBeGreaterThanOrEqual(10)
      expect(usage).not.toHaveProperty("costUsd")
    }
    // Resume: the last step's commit is the ref tip, so the host returns
    // it and the sandbox does no work.
    const tip = assembled.tip
    const replay = { ...assembled, tip: null as string | null }
    const calls: string[] = []
    await runSkillPages({
      step: async (name, fn) => {
        calls.push(name)
        return fn()
      },
      run: {
        runId: RUN_ID,
        bundle: "ingest-contract",
        source: {
          kind: "github" as const,
          url: SOURCE_URL,
          githubConnectionId: "con_contract",
          sha: source.sha,
          repositoryId: null,
        },
        authorTime: AUTHOR_TIME,
        roots: ROOTS,
      },
      broker,
      runtime: {
        ...runtime,
        runStep: () => Promise.reject(new Error("A replay runs no step")),
      },
      root: null,
      skill: skills.find(
        (s) => s.name === "instruction-areas",
      ) as IngestSkillPlan,
      destination,
      ref: ASSEMBLED,
      runBase: pinned,
      state: replay,
    })
    expect(replay.tip).toBe(tip)
    expect(replay.partial).toBe(0)
  }, 600_000)
})
