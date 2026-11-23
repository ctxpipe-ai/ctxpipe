import { execFileSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { SpanStatusCode } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, vi } from "vitest"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { connections } from "../db/schema/connections.js"
import { workspaces, workspaceWriteJobs } from "../db/schema/workspaces.js"
import { readIngestSkillBundle } from "../domain/ingestion/skill-bundle.js"
import { githubSourcePath } from "../domain/workspace-sources/source-file.js"
import { workspaceFormatFile } from "../domain/workspaces/workspace-format.js"
import { generateObjectId } from "../lib/id.js"
import { replaceWorkspaceSourceRows } from "../models/workspace-sources.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import { defineIngestionShardWorkflow } from "../openworkflow/workflows/ingestion-shard.js"
import {
  defineRepositoryIngestionV2Workflow,
  type IngestionV2Output,
} from "../openworkflow/workflows/repository-ingestion-v2.js"
import { defineWorkspaceExtractIngestWorkflow } from "../openworkflow/workflows/workspace-extract-ingest.js"
import { workspaceSemanticMerge } from "../openworkflow/workflows/workspace-semantic-merge.js"
import { type IngestModelStep } from "./ingest-child-worker.js"
import {
  githubTokenHandlers,
  type GithubTokenLog,
  insertGithubConnection,
  stubGithubApp,
} from "./ingest-github.js"
import { standInIngestShardRuntime } from "./ingest-shard-stand-in.js"

/*
 * The fixture of the ingestion v2 publish tests
 * (src/openworkflow/workflows/repository-ingestion-v2-publish*.integration.test.ts).
 * Its hooks set up the fixture for the test file that imports it. Each test
 * file gets its own copy, so the files can run at the same time in their own
 * shards.
 *
 * Ingestion v2 publish (T21), with real Postgres, a real OpenWorkflow worker,
 * the real broker, and real git. GitHub is a set of local bare repositories
 * (`url.<dir>.insteadOf https://github.com/`); msw mints its tokens and
 * answers the model calls of the host stand-in sandbox.
 */

export const MODEL_URL = "https://ingest-model.test/v1/step"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}

export const orgId = generateObjectId("org")
const connectionId = generateObjectId("con")
export const suffix = Math.random().toString(36).slice(2, 8)
const sourceName = `acme/billing-api-${suffix}`
export const contexts = [`acme/context-a-${suffix}`, `acme/context-b-${suffix}`]
export const workspaceIds = [
  generateObjectId("ws"),
  generateObjectId("ws"),
].sort()
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
/** When `pushed` is false, a human commit lands on context B during the run. */
export const human = { pushed: true, sha: "" }
/** Each run writes another text, so each run has a delta to publish. */
export let edition = 1
/** When armed, a person unlinks the source from context A during the run. */
export const unlink = { armed: false, sha: "" }
/**
 * When set, a person adds `addition` to the run's file on context A while the
 * run is in its steps. The semantic merge model answers with `reply`:
 * `append` gives the run's text plus `resolution`, and `none` resolves no
 * path (a schema mismatch of the resolver).
 */
export const sameFile = {
  armed: false,
  sha: "",
  addition: "",
  reply: "append" as "append" | "none",
  resolution: "",
  /** The run also writes a new file to context A, which no person changed. */
  newFile: false,
  /** `billing-jobs` is on the default branch too, and a person edits it. */
  second: false,
}
/**
 * A source with 21 roots (two shards). In context A, roots p20 (shard 0) and
 * p21 (shard 1) both write `knowledge/services/shared.md`.
 */
export const wideName = `acme/wide-monorepo-${suffix}`
/**
 * A source whose one root step writes more files than the old op caps let
 * through (30 for each step, 300 for each Workspace in a run, CTX-1482).
 */
export const floodName = `acme/flood-monorepo-${suffix}`
export const FLOOD_FILES = 310
const MERGE_MODEL_URL = "https://merge-model.test/v1"

/** The stand-in agent's reply to a model step. */
export function modelReply(body: IngestModelStep) {
  if (body.args?.includes(`https://github.com/${floodName}`))
    return {
      more: false,
      files: Array.from({ length: FLOOD_FILES }, (_, i) => {
        const name = `flood-${String(i).padStart(3, "0")}`
        return {
          path: `knowledge/services/${name}.md`,
          content: `---\nkind: Service\nname: ${name}\n---\n# ${name}\n\nThe ${name} service sends invoices.\n`,
        }
      }),
    }
  if (body.workspaceId === workspaceIds[1] && !human.pushed) {
    human.pushed = true
    human.sha = humanCommit(contexts[1] ?? "")
  }
  if (body.workspaceId === workspaceIds[0] && unlink.armed) {
    unlink.armed = false
    unlink.sha = humanUnlink(contexts[0] ?? "", sourceFileOf(sourceName))
  }
  if (body.workspaceId === workspaceIds[0] && sameFile.armed) {
    sameFile.armed = false
    sameFile.sha = humanEdit(
      contexts[0] ?? "",
      "knowledge/services/billing-api.md",
      sameFile.addition,
    )
    if (sameFile.second)
      sameFile.sha = humanEdit(
        contexts[0] ?? "",
        "knowledge/services/billing-jobs.md",
        sameFile.addition,
      )
  }
  const root = body.root ?? "."
  const name = root === "." ? "billing-api" : (root.split("/").pop() ?? root)
  const extra =
    (sameFile.newFile || sameFile.second) && name === "billing-api"
      ? ["billing-jobs"]
      : ([] as string[])
  return {
    more: false,
    files: [
      {
        path:
          (name === "p20" || name === "p21") &&
          body.workspaceId === workspaceIds[0]
            ? "knowledge/services/shared.md"
            : `knowledge/services/${name}.md`,
        content: `---\nkind: Service\nname: ${name}\n---\n# ${name}\n\nThe ${name} service sends invoices (edition ${edition}).\n`,
      },
      ...extra.map((other) => ({
        path: `knowledge/services/${other}.md`,
        content: `---\nkind: Service\nname: ${other}\n---\n# ${other}\n\nThe ${other} service sends invoices (edition ${edition}).\n`,
      })),
    ],
  }
}

/** The step name of each model call of the in-process worker. */
export const modelSteps: string[] = []

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => "fixture-only-github-token"),
  http.post(MODEL_URL, async ({ request }) => {
    const body = (await request.json()) as IngestModelStep
    modelSteps.push(body.step)
    return HttpResponse.json(modelReply(body))
  }),
  http.post(`${MERGE_MODEL_URL}/chat/completions`, async ({ request }) => {
    const body = (await request.json()) as {
      messages: Array<{ content: string }>
    }
    const conflicts = JSON.parse(body.messages[1]?.content ?? "[]") as Array<{
      path: string
      incoming: string | null
    }>
    return HttpResponse.json({
      id: "fixture-merge",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "merge-resolution",
                type: "function",
                function: {
                  name: "workspace_semantic_merge",
                  arguments: JSON.stringify({
                    files:
                      sameFile.reply === "none"
                        ? []
                        : conflicts.map((c) => ({
                            path: c.path,
                            content: `${c.incoming ?? ""}${sameFile.resolution}`,
                          })),
                  }),
                },
              },
            ],
          },
        },
      ],
    })
  }),
)

export let folder: string
export let remotes: string
/** The bundle of the in-process worker; a test can change it (a deploy). */
export let bundleDir: string
let backend: BackendPostgres
export let worker: ReturnType<OpenWorkflow["newWorker"]>
export let runner: OpenWorkflow
let parent: ReturnType<typeof defineRepositoryIngestionV2Workflow>
export const workspaceExtractIngest = defineWorkspaceExtractIngestWorkflow()
let sourceSha: string
export let wideSha: string
export let floodSha: string
export const pinned: string[] = []

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  }).trim()
}

function remote(name: string, files: Record<string, string>): string {
  const work = mkdtempSync(join(folder, "work-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), content)
  }
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "seed")
  const bare = join(remotes, name)
  mkdirSync(dirname(bare), { recursive: true })
  execFileSync("git", ["clone", "-q", "--bare", work, bare])
  return git(work, "rev-parse", "HEAD")
}

/** A person adds `notes/human.md` on the default branch of `name`. */
function humanCommit(name: string): string {
  const work = mkdtempSync(join(folder, "human-"))
  git(work, "clone", "-q", join(remotes, name), ".")
  mkdirSync(join(work, "notes"), { recursive: true })
  writeFileSync(join(work, "notes/human.md"), "# Notes from a person\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "Add notes")
  git(work, "push", "-q", "origin", "main")
  return git(work, "rev-parse", "HEAD")
}

/** The source file that links `repository` in each Workspace (ADR-050). */
export function sourceFileOf(repository: string): string {
  const [owner = "", name = ""] = repository.split("/")
  return githubSourcePath(owner, name)
}

export function sourceFileText(repository: string): string {
  return `---\nprovider: github\nconnection: ${connectionId}\nrepository: ${repository}\n---\n`
}

/** A person deletes the source file `path` of `name`: an unlink. */
function humanUnlink(name: string, path: string): string {
  const work = mkdtempSync(join(folder, "human-"))
  git(work, "clone", "-q", join(remotes, name), ".")
  git(work, "rm", "-q", path)
  git(work, "commit", "-q", "-m", "Unlink the source")
  git(work, "push", "-q", "origin", "main")
  return git(work, "rev-parse", "HEAD")
}

/**
 * A person sets the Workspace format of `name` on its default branch: an
 * upgrade pull request, or the revert of one.
 */
export function humanFormat(name: string, format: number): string {
  const work = mkdtempSync(join(folder, "human-"))
  git(work, "clone", "-q", join(remotes, name), ".")
  const file = workspaceFormatFile(format)
  writeFileSync(join(work, file.path), file.content)
  git(work, "commit", "-q", "-am", `Set the Workspace format to ${format}`)
  git(work, "push", "-q", "origin", "main")
  return git(work, "rev-parse", "HEAD")
}

/** A person adds `addition` to `path` on the default branch of `name`. */
function humanEdit(name: string, path: string, addition: string): string {
  const work = mkdtempSync(join(folder, "human-"))
  git(work, "clone", "-q", join(remotes, name), ".")
  writeFileSync(
    join(work, path),
    `${readFileSync(join(work, path), "utf8")}${addition}`,
  )
  git(work, "commit", "-q", "-am", "Edit the service")
  git(work, "push", "-q", "origin", "main")
  return git(work, "rev-parse", "HEAD")
}

/**
 * Each test starts from the seed: each default branch and pin at its seed
 * commit, no ingest ref, and no person who edits during the run.
 */
export async function resetContexts() {
  for (const [i, name] of contexts.entries()) {
    const bare = join(remotes, name)
    git(bare, "update-ref", "refs/heads/main", pinned[i] ?? "")
    for (const ref of git(
      bare,
      "for-each-ref",
      "--format=%(refname)",
      "refs/ctxpipe/",
    )
      .split("\n")
      .filter(Boolean))
      git(bare, "update-ref", "-d", ref)
    await withOrgDbContext(orgId, (db) =>
      db
        .update(workspaces)
        .set({
          desiredSha: pinned[i],
          writeStatus: "writable",
          formatVersion: 3,
        })
        .where(eq(workspaces.id, workspaceIds[i] ?? "")),
    )
  }
  Object.assign(human, { pushed: true, sha: "" })
  Object.assign(unlink, { armed: false, sha: "" })
  Object.assign(sameFile, {
    armed: false,
    sha: "",
    addition: "\nA person checks this file each week.\n",
    reply: "append",
    resolution: "",
    newFile: false,
    second: false,
  })
  edition++
}

/**
 * A first publish, so `knowledge/services/billing-api.md` is on each default
 * branch, then the pins move to the tips. The next run gets a new edition.
 */
export async function publishBase(authorTime: string) {
  const handle = await startRun(authorTime)
  await expect(handle.result({ timeoutMs: 400_000 })).resolves.toMatchObject({
    status: "done",
  })
  await movePinsToTips()
  edition++
  return handle.workflowRun.id
}

/** Each pin moves to the default tip, as the hydrate of a publish does. */
async function movePinsToTips() {
  for (const [i, name] of contexts.entries())
    await withOrgDbContext(orgId, (db) =>
      db
        .update(workspaces)
        .set({ desiredSha: git(join(remotes, name), "rev-parse", "main") })
        .where(eq(workspaces.id, workspaceIds[i] ?? "")),
    )
}

export function refsOf(name: string, runId: string): string[] {
  return git(
    join(remotes, name),
    "for-each-ref",
    "--format=%(refname)",
    `refs/ctxpipe/ingest/${runId}/`,
  )
    .split("\n")
    .filter(Boolean)
}

export function startRun(
  authorTime: string,
  source = sourceName,
  sha = sourceSha,
) {
  return runner.runWorkflow(parent.spec, {
    orgId,
    shadow: false,
    source: {
      kind: "github" as const,
      url: `https://github.com/${source}`,
      githubConnectionId: connectionId,
    },
    sha,
    authorTime,
  })
}

/** The semantic merge model is the msw handler at `MERGE_MODEL_URL`. */
export function stubMergeModel() {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", MERGE_MODEL_URL)
  vi.stubEnv("MODEL_HIGH_NAME", "fixture-high")
}

/** Put a git on PATH that runs `before` (shell) first, for each call. */
export function wrapGit(dir: string, before: string): string {
  const bin = join(folder, dir)
  mkdirSync(bin)
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim()
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nREAL_GIT="${realGit}"\n${before}\nexec "$REAL_GIT" "$@"\n`,
  )
  chmodSync(join(bin, "git"), 0o755)
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)
  return bin
}

/** Events that the run logger drained, for the check of a logged cause. */
export const loggedEvents: Record<string, unknown>[] = []

export const spanExporter = new InMemorySpanExporter()

beforeAll(async () => {
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  }).register()
  initLogger({
    pretty: false,
    silent: true,
    drain: (ctx) => {
      loggedEvents.push(ctx.event)
    },
  })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for the ingestion v2 publish")
  initDb(databaseUrl)
  stubGithubApp()
  server.listen({ onUnhandledRequest: "bypass" })
  folder = mkdtempSync(join(tmpdir(), "ingestion-v2-publish-"))
  remotes = join(folder, "remotes")
  const gitConfig = join(folder, "gitconfig")
  writeFileSync(
    gitConfig,
    `[url "${remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n[uploadpack]\n\tallowAnySHA1InWant = true\n`,
  )
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig)

  sourceSha = remote(sourceName, {
    "package.json": '{ "name": "billing-api" }\n',
    "README.md": "# Billing API\n",
  })
  // Each Workspace is at format 3, where ingestion v2 publishes, and has a
  // source file for each repository: the publish checks it.
  const format = workspaceFormatFile(3)
  for (const name of contexts)
    pinned.push(
      remote(name, {
        "README.md": "# Context\n",
        [format.path]: format.content,
        [sourceFileOf(sourceName)]: sourceFileText(sourceName),
        [sourceFileOf(wideName)]: sourceFileText(wideName),
        [sourceFileOf(floodName)]: sourceFileText(floodName),
      }),
    )
  floodSha = remote(floodName, {
    "package.json": '{ "name": "flood-monorepo" }\n',
  })
  wideSha = remote(wideName, {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    ...Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => {
        const name = `p${String(i + 1).padStart(2, "0")}`
        return [`packages/${name}/package.json`, `{ "name": "${name}" }\n`]
      }),
    ),
  })

  // The real stage helpers and script skills, and one fixture model skill.
  const real = await readIngestSkillBundle()
  bundleDir = join(folder, "bundle")
  const kept = ["bin", "discover-roots", "repository"]
  for (const file of real.files.filter((f) =>
    kept.includes(f.path.split("/")[0] ?? ""),
  )) {
    mkdirSync(dirname(join(bundleDir, file.path)), { recursive: true })
    writeFileSync(join(bundleDir, file.path), file.content, {
      mode: file.executable ? 0o755 : 0o644,
    })
  }
  writeFileSync(
    join(bundleDir, "version.json"),
    JSON.stringify({ version: real.version }),
  )
  mkdirSync(join(bundleDir, "classify-kind"))
  writeFileSync(
    join(bundleDir, "classify-kind/SKILL.md"),
    "---\nname: classify-kind\ndescription: Fixture model skill.\n---\n# classify-kind\n",
  )

  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingestion v2 publish proof",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 445,
    accountSlug: "acme",
  })
  for (const [i, workspaceId] of workspaceIds.entries()) {
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `publish-${i}-${suffix}`,
        displayName: `Publish ${i}`,
        workspaceRepositoryUrl: `https://github.com/${contexts[i]}`,
        githubConnectionId: connectionId,
        desiredGeneration: 3,
        desiredSha: pinned[i],
        desiredDefaultBranch: "main",
        writeStatus: "writable",
        // The publish gate: ingestion v2 publishes at format 3 or more.
        formatVersion: 3,
      }),
    )
    await replaceWorkspaceSourceRows({
      orgId,
      workspaceId,
      revision: pinned[i] ?? "",
      // One GitHub source file for each repository (ADR-050 revision
      // 2026-10-16).
      rows: [sourceName, wideName, floodName].map((repository) => {
        return {
          sourceKey: sourceFileOf(repository),
          provider: "github" as const,
          connectionId,
          scope: { repository },
          status: "ok" as const,
          statusDetail: null,
        }
      }),
    })
  }

  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  runner = new OpenWorkflow({ backend })
  const deps = {
    runtime: standInIngestShardRuntime({ modelUrl: MODEL_URL, folder }),
    bundle: () => readIngestSkillBundle(bundleDir),
  }
  const shard = defineIngestionShardWorkflow(deps)
  parent = defineRepositoryIngestionV2Workflow({ ...deps, shard })
  runner.implementWorkflow(shard.spec, shard.fn)
  runner.implementWorkflow(parent.spec, parent.fn)
  runner.implementWorkflow(
    workspaceExtractIngest.spec,
    workspaceExtractIngest.fn,
  )
  runner.implementWorkflow(
    workspaceSemanticMerge.spec,
    workspaceSemanticMerge.fn,
  )
  worker = runner.newWorker({ concurrency: 4 })
  await worker.start()
}, 120_000)

afterAll(async () => {
  await worker?.stop()
  await backend?.stop()
  server.close()
  vi.unstubAllEnvs()
  await withOrgDbContext(orgId, async (db) => {
    await db
      .delete(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.orgId, orgId))
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
  rmSync(folder, { recursive: true, force: true })
}, 60_000)

/**
 * The wide run: assemble of context A refuses or fails, so context A
 * publishes nothing, not even the run base (CTX-1482). The run span is an
 * error with the fixed codes of the cause. Context B has no conflict and
 * publishes all of the run.
 */
export function expectNoPublishOnContextA(
  result: IngestionV2Output,
  runId: string,
  rules: string[],
) {
  expect(result).toMatchObject({ status: "partial", shards: 2 })
  if (!("workspaces" in result)) throw new Error("The run did not finish")
  const bare = join(remotes, contexts[0] ?? "")
  const entry = result.workspaces.find((w) => w.workspaceId === workspaceIds[0])
  expect(entry).toMatchObject({ assembled: null, partial: 1, rules })
  expect(entry).not.toHaveProperty("published")
  expect(git(bare, "rev-parse", "main")).toBe(pinned[0])
  expectRefusedRunSpan(runId, rules)
  const other = join(remotes, contexts[1] ?? "")
  expect(git(other, "log", "-1", "--format=%B", "main")).toContain(
    `Ctxpipe-Run: ${runId}`,
  )
  expect(git(other, "ls-tree", "-r", "--name-only", "main")).toContain(
    "knowledge/services/p21.md",
  )
  expect(refsOf(contexts[1] ?? "", runId)).toEqual([])
  return entry
}

/**
 * The run span is an error with one refused Workspace and the fixed codes
 * of the cause (CTX-1482).
 */
export function expectRefusedRunSpan(runId: string, rules: string[]) {
  const runSpan = spanExporter
    .getFinishedSpans()
    .find(
      (span) =>
        span.name === "ingestion.run" &&
        span.attributes["ctxpipe.ingest.run.id"] === runId,
    )
  expect(runSpan?.status.code).toBe(SpanStatusCode.ERROR)
  expect(runSpan?.attributes).toMatchObject({
    "ctxpipe.ingest.status": "partial",
    "error.type": "workspace_refused",
    "ctxpipe.ingest.refused": 1,
    "ctxpipe.ingest.refused.rules": rules,
  })
}

/** The publish of context A is refused or fails; context B publishes. */
export function expectOnlyContextBPublished(
  result: IngestionV2Output,
  runId: string,
) {
  expect(result).toMatchObject({ status: "partial" })
  if (!("workspaces" in result)) throw new Error("The run did not finish")
  expect(
    git(join(remotes, contexts[1] ?? ""), "log", "-1", "--format=%B", "main"),
  ).toContain(`Ctxpipe-Run: ${runId}`)
  expect(refsOf(contexts[1] ?? "", runId)).toEqual([])
  const entry = result.workspaces.find((w) => w.workspaceId === workspaceIds[0])
  expect(entry).toMatchObject({ published: null, partial: 1 })
  return entry
}

/**
 * The `ingestion-v2.partial` events of the publish to context A. The event
 * name is in `step`, as for each other `ingestion-v2.*` event.
 */
export function partialLogsOf(runId: string) {
  return loggedEvents.filter(
    (event) =>
      event.level === "warn" &&
      event.step === "ingestion-v2.partial" &&
      event.ingestionRunId === runId &&
      event.workspaceId === workspaceIds[0] &&
      event.ingestStep === "publish",
  )
}

/** The `ingestion-v2.publish-withheld` events of the publish to context A. */
export function withheldLogsOf(runId: string) {
  return loggedEvents.filter(
    (event) =>
      event.step === "ingestion-v2.publish-withheld" &&
      event.ingestionRunId === runId &&
      event.workspaceId === workspaceIds[0],
  )
}

/** A git wrapper: each tip read of context A comes after one more commit of a person, while `flag` exists. */
export function raceContextA(flag: string): string {
  const bare = join(remotes, contexts[0] ?? "")
  return wrapGit(
    `race-bin-${flag.split("/").pop()}`,
    [
      `if [ -f "${flag}" ]; then`,
      `case " $* " in *" ls-remote "*"--symref"*"context-a-${suffix}"*)`,
      `  T=$("$REAL_GIT" --git-dir="${bare}" rev-parse main)`,
      `  C=$(echo race | GIT_AUTHOR_NAME=person GIT_AUTHOR_EMAIL=person@example.test GIT_COMMITTER_NAME=person GIT_COMMITTER_EMAIL=person@example.test "$REAL_GIT" --git-dir="${bare}" commit-tree "$T^{tree}" -p "$T")`,
      `  "$REAL_GIT" --git-dir="${bare}" update-ref refs/heads/main "$C" "$T" ;;`,
      "esac",
      "fi",
    ].join("\n"),
  )
}

/** A deploy: later steps of the in-process worker read this bundle. */
export function setBundleDir(dir: string) {
  bundleDir = dir
}

/** The worker that afterAll stops: a test that starts a new one sets it. */
export function setWorker(next: ReturnType<OpenWorkflow["newWorker"]>) {
  worker = next
}
