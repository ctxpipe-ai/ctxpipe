import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { stringify } from "yaml"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import { contextIndexAtStepBase } from "./context-index.js"
import { ingestOpenCodeConfig } from "./ingest-opencode.js"
import { collectIngestStep } from "./ingest-prepare.js"
import { dockerRootExec, type RootExec, runAsRoot } from "./ingest-root.js"
import {
  ingestAgentEnv,
  ingestSkillArguments,
  prepareIngestShard,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import type { IngestRootMap } from "./ingest-shard-runtime.js"
import { withIngestStepOutput } from "./ingest-step-output.js"
import { gitSourcePathExists, validatePatchStep } from "./patch-validator.js"
import { readIngestSkillBundle } from "./skill-bundle.js"

/*
 * Contract (Docker): each ingest skill runs through the host step path
 * (`runIngestShardStep`, ADR-052 section 6) in a real chat sandbox image.
 * The host gives each step the same inputs (`--source`, `--source-url`,
 * `--roots`, and `--path` for a root step), the context index from the host
 * path, and the root-to-file map. A model skill runs `opencode run` against
 * a deterministic model stub in the container: the stub returns a fixed list
 * of tool calls (the skill's scripts with the step's arguments, and fixed
 * agent writes). The staged tree of each step must pass the patch validator,
 * with the step's root, and hold the expected claims.
 *
 * Run: pnpm --filter @ctxpipe/backend exec vitest run
 *   src/domain/ingestion/ingest-skill-steps.contract.test.ts
 */

const SOURCE_URL = "https://github.com/example-org/shop"
const WORKSPACE_ID = "ws_steps"
const STUB_PORT = 47813
const STUB_CALLS = "/tmp/stub-calls.json"
const AGENT_WRITE = "/tmp/agent-write.mjs"
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
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
const owned = (attributes: object, body: string) =>
  front(
    {
      ...attributes,
      generated_by: "ctxpipe-extract",
      sources: [SOURCE_URL],
    },
    body,
  )

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

/** The context at the run base: the repository unit and the root files of earlier steps. */
const CONTEXT: Record<string, string> = {
  "README.md": "# Context\n",
  [CODEBASE]: owned(
    { kind: "Repository", name: "example-org/shop", root: "." },
    "# example-org/shop\n",
  ),
  [API_SERVICE]: owned(
    { kind: "Service", name: "api", root: "apps/api" },
    "# api\n\nThe API service.\n",
  ),
  [WEB_APP]: owned(
    { kind: "App", name: "web", root: "apps/web" },
    "# web\n\nThe web app.\n",
  ),
  [BILLING]: front(
    { kind: "Service", name: "Billing", summary: "The billing service." },
    "# Billing\n\nThe team wrote this.\n",
  ),
}

const ROOT_MAP: IngestRootMap = {
  roots: [
    {
      path: ".",
      manifests: ["package.json"],
      evidence: ["pnpm-workspace.yaml"],
      files: [],
    },
    {
      path: "apps/api",
      manifests: ["apps/api/package.json"],
      evidence: ["pnpm-workspace.yaml"],
      files: [API_SERVICE],
    },
    {
      path: "apps/web",
      manifests: ["apps/web/package.json"],
      evidence: ["pnpm-workspace.yaml"],
      files: [WEB_APP],
    },
  ],
}

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
    res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\\n\\n")
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
let context: { dir: string; sha: string }
let source: { dir: string; sha: string }
let index: string

/** The same commit on the host and in the container: fixed dates and author. */
function hostRepo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = mkdtempSync(join(host, "repo-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
    }).trim()
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "seed")
  return { dir, sha: git("rev-parse", "HEAD") }
}

async function containerRepo(
  remote: string,
  files: Record<string, string>,
): Promise<string> {
  const work = `${remote}.work`
  for (const [path, content] of Object.entries(files)) {
    await handle.process.exec(`mkdir -p ${quote(dirname(`${work}/${path}`))}`)
    await handle.fs.write(`${work}/${path}`, content)
  }
  const result = await handle.process.exec(
    `cd ${work} && git init -q -b main && git add -A && git commit -q -m seed && git clone -q --bare ${work} ${remote} && git rev-parse HEAD`,
    { env: GIT_ENV },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

beforeAll(async () => {
  host = mkdtempSync(join(tmpdir(), "ingest-skill-steps-"))
  source = hostRepo(SOURCE)
  context = hostRepo(CONTEXT)
  // The host path: the index at the step base. The projection is empty, so
  // each context file is a file that the run wrote (the first step and the
  // root steps before the repository-wide ones).
  index = (
    await contextIndexAtStepBase({
      workspaceId: WORKSPACE_ID,
      projection: [],
      pinnedRevision: EMPTY_TREE,
      base: context.sha,
      sourceUrl: SOURCE_URL,
      repoDir: context.dir,
    })
  ).json

  const bundle = await readIngestSkillBundle()
  provider = dockerSandbox({ image: workspaceChatDockerImage() })
  handle = await provider.create({
    id: `ingest-steps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })
  root = dockerRootExec(handle.id)
  await runAsRoot(root, "git config --system --add safe.directory '*'")
  const sourceSha = await containerRepo("/tmp/remotes/source.git", SOURCE)
  const contextSha = await containerRepo("/tmp/remotes/context.git", CONTEXT)
  expect([sourceSha, contextSha]).toEqual([source.sha, context.sha])
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
    source: { url: "/tmp/remotes/source.git", sha: source.sha },
    contexts: [{ workspaceId: WORKSPACE_ID, url: "/tmp/remotes/context.git" }],
    now: new Date("2026-10-01T00:00:00Z"),
  })
  await handle.fs.write(STUB_CALLS, "[]")
  await handle.fs.write(AGENT_WRITE, AGENT_WRITE_SCRIPT)
  await handle.fs.write("/tmp/stub-model.mjs", STUB_MODEL)
  await handle.process.exec(
    "chmod 644 /tmp/stub-calls.json /tmp/agent-write.mjs && nohup node /tmp/stub-model.mjs >/tmp/stub.out 2>&1 &",
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

/**
 * Run one skill step through the host step path, and validate its staged
 * tree as the host does, with the step's root.
 */
async function hostStep(input: {
  skill: string
  run: "script" | "model"
  root: string | null
  /** Model steps: the bash commands that the stub agent runs. */
  calls?: (args: string) => string[]
}) {
  const args = ingestSkillArguments({ root: input.root, sourceUrl: SOURCE_URL })
  await handle.fs.write(
    STUB_CALLS,
    JSON.stringify(input.calls ? input.calls(args) : []),
  )
  await runIngestShardStep(root, {
    step: {
      name: `skill:${input.root ?? "repository"}:${input.skill}:${WORKSPACE_ID}`,
      skill: input.skill,
      run: input.run,
      root: input.root,
      workspaceId: WORKSPACE_ID,
      baseCommit: context.sha,
      rootMap: ROOT_MAP,
      signal: AbortSignal.timeout(300_000),
    },
    agentEnv,
    remote: "/tmp/remotes/context.git",
    sourceUrl: SOURCE_URL,
    index,
  })
  const tar = await collectIngestStep(handle, root)
  const result = await withIngestStepOutput(tar, (stagedDir) =>
    validatePatchStep({
      repoDir: context.dir,
      baseCommit: context.sha,
      stagedDir,
      source: { url: SOURCE_URL, sha: source.sha },
      skill: input.skill,
      bundle: "ingest-contract",
      sourcePathExists: gitSourcePathExists(source.dir, source.sha),
      linkableRepositories: [SOURCE_URL],
      ...(input.root === null ? {} : { root: input.root }),
    }),
  )
  const show = (path: string) =>
    execFileSync("git", ["-C", context.dir, "show", `${result.tree}:${path}`], {
      encoding: "utf8",
    })
  return { result, show }
}

describe("each ingest skill through the host step path (Docker)", () => {
  it("classify-kind: a root step links the root's file to the repository unit and gets the host root", async () => {
    const { result, show } = await hostStep({
      skill: "classify-kind",
      run: "model",
      root: "apps/api",
      calls: (args) => [
        `node /ctxpipe/skills/classify-kind/scripts/classify-kind.mjs ${args}`,
      ],
    })
    expect(result.rejections).toEqual([])
    expect(result.accepted).toEqual([{ op: "update", path: API_SERVICE }])
    const text = show(API_SERVICE)
    expect(text).toContain("predicate: IMPLEMENTED_IN")
    expect(text).toContain("to: ../codebases/shop.md")
    expect(text).toContain("root: apps/api")
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
    const { result, show } = await hostStep({
      skill: "apis",
      run: "model",
      root: "apps/api",
      calls: (args) => [
        `node /ctxpipe/skills/apis/scripts/find-apis.mjs ${args}`,
        `printf %s ${quote(JSON.stringify(plan))} > /ctxpipe/home/apis-plan.json`,
        `node /ctxpipe/skills/apis/scripts/write-apis.mjs ${args} --plan /ctxpipe/home/apis-plan.json`,
      ],
    })
    expect(result.rejections).toEqual([])
    const paths = result.accepted.map((op) => op.path)
    expect(paths).toContain("knowledge/apis/invoices-api.md")
    expect(paths.some((p) => p.startsWith("knowledge/operations/"))).toBe(true)
    expect(show("knowledge/apis/invoices-api.md")).toContain(
      "predicate: HAS_OPERATION",
    )
    expect(show(API_SERVICE)).toContain("predicate: EXPOSES_API")
  }, 600_000)

  it("dependencies: a root step writes DEPENDS_ON from the root's Service to the billing Service", async () => {
    const resolve = [
      "const fs = require('node:fs')",
      "const scan = JSON.parse(fs.readFileSync('/ctxpipe/home/scan.json', 'utf8'))",
      "const call = scan.candidates.find((c) => c.target.text.endsWith('/invoices'))",
      `fs.writeFileSync('/ctxpipe/out/resolutions.json', JSON.stringify({ resolutions: [{ id: call.id, kind: 'service', path: '${BILLING}' }] }))`,
    ].join(";")
    const { result, show } = await hostStep({
      skill: "dependencies",
      run: "model",
      root: "apps/api",
      calls: (args) => [
        `node /ctxpipe/skills/dependencies/scripts/scan.mjs ${args} > /ctxpipe/home/scan.json`,
        `node -e ${quote(resolve)}`,
        `node /ctxpipe/skills/dependencies/scripts/apply.mjs ${args} --resolutions /ctxpipe/out/resolutions.json`,
      ],
    })
    expect(result.rejections).toEqual([])
    expect(result.accepted).toEqual([{ op: "update", path: API_SERVICE }])
    const text = show(API_SERVICE)
    expect(text).toContain("predicate: DEPENDS_ON")
    expect(text).toContain("to: billing.md")
  }, 600_000)

  it("datasources-infra: the repository-wide step writes the shared store file and READS_FROM from the App", async () => {
    const store = "knowledge/databases/postgresql-for-web.md"
    const storeText = front(
      {
        kind: "Database",
        name: "PostgreSQL for web",
        summary: "Primary relational store of the web app.",
      },
      "# PostgreSQL for web\n\nRole: primary store. The web app reads it through the `pg` driver.\n",
    )
    // The agent never writes a host field (generated_by, sources, root).
    const appText = front(
      {
        kind: "App",
        name: "web",
        claims: [
          {
            to: "../databases/postgresql-for-web.md",
            predicate: "READS_FROM",
            evidence: { path: "apps/web/package.json", kind: "script" },
          },
        ],
      },
      "# web\n\nThe web app.\n",
    )
    const { result, show } = await hostStep({
      skill: "datasources-infra",
      run: "model",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/datasources-infra/scripts/find-stores.mjs ${args}`,
        agentWrite(store, storeText),
        agentWrite(WEB_APP, appText),
      ],
    })
    expect(result.rejections).toEqual([])
    expect(result.accepted.map((op) => op.path).sort()).toEqual(
      [WEB_APP, store].sort(),
    )
    expect(show(WEB_APP)).toContain("predicate: READS_FROM")
    expect(show(store)).toContain("kind: Database")
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
    const { result, show } = await hostStep({
      skill: "decisions",
      run: "model",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/decisions/scripts/decisions.mjs ${args} > /ctxpipe/home/decisions.json`,
        `node -e ${quote(write)}`,
        `node /ctxpipe/skills/decisions/scripts/decisions.mjs ${args} --check`,
      ],
    })
    expect(result.rejections).toEqual([])
    expect(result.accepted).toHaveLength(1)
    const [decision] = result.accepted
    expect(decision?.path.startsWith("knowledge/decisions/")).toBe(true)
    const text = show(decision?.path ?? "")
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
    const { result, show } = await hostStep({
      skill: "instruction-areas",
      run: "model",
      root: null,
      calls: (args) => [
        `node /ctxpipe/skills/instruction-areas/scripts/documents.mjs ${args}`,
        `printf %s ${quote(JSON.stringify(proposal))} > /ctxpipe/out/proposal.json`,
        `node /ctxpipe/skills/instruction-areas/scripts/instruction-areas.mjs ${args} --proposal /ctxpipe/out/proposal.json --now 2026-10-01T00:00:00Z`,
      ],
    })
    expect(result.rejections).toEqual([])
    expect(result.accepted.map((op) => op.path).sort()).toEqual(
      [CODEBASE, "knowledge/instructions/unit-testing.md"].sort(),
    )
    const unit = show(CODEBASE)
    expect(unit).toContain("predicate: FOLLOWS")
    expect(unit).toContain("to: ../instructions/unit-testing.md")
  }, 600_000)

  it("libraries: the repository-wide script step writes library files and USES_LIBRARY from the root's Service", async () => {
    const { result, show } = await hostStep({
      skill: "libraries",
      run: "script",
      root: null,
    })
    expect(result.rejections).toEqual([])
    const paths = result.accepted.map((op) => op.path)
    expect(paths).toContain(API_SERVICE)
    expect(paths.some((p) => p.startsWith("knowledge/libraries/"))).toBe(true)
    expect(show(API_SERVICE)).toContain("predicate: USES_LIBRARY")
  }, 600_000)

  it("ownership: the repository-wide script step writes the team file with OWNS to the root's Service", async () => {
    const { result, show } = await hostStep({
      skill: "ownership",
      run: "script",
      root: null,
    })
    expect(result.rejections).toEqual([])
    const team = result.accepted.find((op) =>
      op.path.startsWith("knowledge/teams/"),
    )
    expect(team).toBeDefined()
    const text = show(team?.path ?? "")
    expect(text).toContain("predicate: OWNS")
    expect(text).toContain("to: ../services/api.md")
  }, 600_000)
})
