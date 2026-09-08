import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { getWriteJobCommitSha } from "../../models/workspace-write-jobs.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { withHeldSemanticHandoffCommit } from "../../test/native-workflow-ack-loss.js"

it.each(["Git staging", "semantic handoff", "unborn push"] as const)(
  "two replacement processes recover a writer killed after %s",
  { timeout: 120_000 },
  async (boundary) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        let writeCredentials = 0
        const unexpectedRequests: string[] = []
        // Only paid/third-party HTTP is substituted. Both child processes execute
        // the real workflow, database, model client, credential broker and Git.
        const server = createServer(async (request, response) => {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
          let value: unknown
          if (
            request.method === "POST" &&
            request.url?.endsWith("/access_tokens")
          ) {
            const writing = body.permissions?.contents === "write"
            if (writing) writeCredentials++
            response.statusCode = 201
            value = {
              token: writing
                ? "fixture-only-github-write-token"
                : "fixture-only-github-read-token",
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: {
                contents: writing ? "write" : "read",
                metadata: "read",
              },
            }
          } else if (
            request.method === "GET" &&
            request.url === "/repos/fixture/hydration-contract"
          ) {
            value = { default_branch: "main", permissions: { push: true } }
          } else if (
            request.method === "POST" &&
            request.url === "/v1/chat/completions"
          ) {
            value = {
              id: "fixture-worker-loss",
              object: "chat.completion",
              created: 1,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "ctxpipe - Recover native workspace bootstrap",
                  },
                  finish_reason: "stop",
                },
              ],
            }
          } else {
            unexpectedRequests.push(`${request.method} ${request.url}`)
            response.statusCode = 500
            value = { error: "Unexpected fixture endpoint" }
          }
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(value))
        })
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", resolve)
        })
        const address = server.address()
        if (!address || typeof address === "string")
          throw new Error("Fixture HTTP listener missing")
        const proxy = `http://127.0.0.1:${address.port}`
        const require = createRequire(import.meta.url)
        const script = join(f.directory, "native-worker.ts")
        writeFileSync(
          script,
          `
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  return nativeFetch(["api.github.com", "hydrate-model.test"].includes(url.hostname)
    ? new Request(${JSON.stringify(proxy)} + url.pathname + url.search, request) : request);
};
const { OpenWorkflow } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow")).href)});
const { BackendPostgres } = await import(${JSON.stringify(pathToFileURL(require.resolve("openworkflow/postgres")).href)});
const { initDb } = await import(${JSON.stringify(new URL("../../db/client.ts", import.meta.url).href)});
const { workspaceBootstrap } = await import(${JSON.stringify(new URL("../../openworkflow/workflows/workspace-bootstrap.ts", import.meta.url).href)});
const { workspaceSemanticMerge } = await import(${JSON.stringify(new URL("../../openworkflow/workflows/workspace-semantic-merge.ts", import.meta.url).href)});
initDb(process.env.DATABASE_URL);
const backend = await BackendPostgres.connect(process.env.DATABASE_URL, { namespaceId: ${JSON.stringify(f.id)}, runMigrations: false });
const runner = new OpenWorkflow({ backend });
runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn);
runner.implementWorkflow(workspaceSemanticMerge.spec, workspaceSemanticMerge.fn);
const worker = runner.newWorker({ concurrency: 1 });
await worker.start();
await new Promise(() => {});
`,
        )
        const ready = join(f.directory, "staging-interrupted")
        const release = join(f.directory, "release-staging")
        const bin = join(f.directory, "crash-bin")
        mkdirSync(bin)
        const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], {
          encoding: "utf8",
        }).trim()
        writeFileSync(
          join(bin, "git"),
          `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (result.status === 0 && args.includes(${JSON.stringify(boundary === "unborn push" ? "push" : "hash-object")}) && !existsSync(${JSON.stringify(ready)})) {
  writeFileSync(${JSON.stringify(ready)}, args[args.indexOf("-C") + 1]);
  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
process.exit(result.status ?? 1);
`,
          { mode: 0o700 },
        )
        const children: Array<{ child: ChildProcess; exited: Promise<void> }> =
          []
        let childErrors = ""
        const launch = (crash: boolean, databaseUrl = f.databaseUrl) => {
          const child = spawn("bun", [script], {
            cwd: f.directory,
            detached: true,
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              ...(crash ? { PATH: `${bin}:${process.env.PATH}` } : {}),
            },
            stdio: ["ignore", "ignore", "pipe"],
          })
          child.stderr?.on("data", (data) => {
            childErrors = (childErrors + data.toString()).slice(-12_000)
          })
          const exited = new Promise<void>((resolve) =>
            child.once("exit", () => resolve()),
          )
          const entry = { child, exited }
          children.push(entry)
          return entry
        }
        const kill = async (entry: (typeof children)[number]) => {
          if (
            entry.child.pid &&
            entry.child.exitCode === null &&
            entry.child.signalCode === null
          )
            process.kill(-entry.child.pid, "SIGKILL")
          await entry.exited
        }
        try {
          await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
          const jobId = `wjob_${f.id}_worker_loss`
          if (boundary === "unborn push") {
            rmSync(f.remote, { recursive: true, force: true })
            f.git("init", "--bare", "--initial-branch=main", f.remote)
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaces)
                .set({
                  desiredSha: null,
                  desiredDefaultBranch: null,
                  indexedSha: null,
                })
                .where(eq(workspaces.id, f.workspaceId)),
            )
          }
          const handle = await f.runner.runWorkflow(workspaceBootstrap.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            ...(boundary === "unborn push"
              ? {
                  bootstrapBinding: {
                    workspaceId: f.workspaceId,
                    generation: 1,
                    remote: f.revision.remote,
                    defaultBranch: "main",
                  },
                }
              : {
                  revision: { ...f.revision, access: "write-default" as const },
                }),
          })
          const exercise = async (
            databaseUrl: string,
            committed?: Promise<void>,
          ) => {
            const original = launch(true, databaseUrl)
            await expect
              .poll(() => existsSync(ready), {
                timeout: 20_000,
                message:
                  "The original native worker must reach the native Git boundary",
              })
              .toBe(true)
            const advanceHuman = (body: string) => {
              writeFileSync(join(f.directory, "document-000.md"), body)
              f.git("add", "document-000.md")
              f.git(
                "-c",
                "user.name=Contract",
                "-c",
                "user.email=contract@example.test",
                "commit",
                "-m",
                "Human advance",
              )
              f.git("push", f.remote, "HEAD:refs/heads/main")
            }
            if (boundary === "semantic handoff") {
              advanceHuman("# First concurrent human revision\n")
              writeFileSync(release, "continue")
              let stored = false
              void committed?.then(() => {
                stored = true
              })
              await expect
                .poll(() => stored, {
                  timeout: 20_000,
                  message:
                    "Observe the actual semantic handoff COMMIT before killing the writer",
                })
                .toBe(true)
            }
            await kill(original)
            if (boundary === "semantic handoff")
              advanceHuman("# Second concurrent human revision\n")
            const lostDirectory = readFileSync(ready, "utf8")
            expect(
              lostDirectory.startsWith(join(tmpdir(), "ctxpipe-write-step-")),
            ).toBe(true)
            rmSync(lostDirectory, { recursive: true, force: true })
            launch(false)
            launch(false)
            const result = await handle.result({ timeoutMs: 55_000 })
            const tip = f.git("--git-dir", f.remote, "rev-parse", "main")
            expect(result).toEqual({ committed: true, commitSha: tip })
            expect(
              f.git(
                "--git-dir",
                f.remote,
                "rev-list",
                "--count",
                boundary === "unborn push" ? "main" : `${f.sha}..main`,
              ),
            ).toBe(boundary === "semantic handoff" ? "3" : "1")
            if (boundary === "semantic handoff")
              expect(
                f.git("--git-dir", f.remote, "show", "main:document-000.md"),
              ).toBe("# Second concurrent human revision")
            expect(
              f
                .git(
                  "--git-dir",
                  f.remote,
                  "ls-tree",
                  "-r",
                  "--name-only",
                  "main",
                )
                .split("\n"),
            ).toContain("AGENTS.md")
            expect(
              await withOrgIdContext(f.org, () => getWriteJobCommitSha(jobId)),
            ).toBe(tip)
            const attempts = (
              await f.backend.listStepAttempts({
                workflowRunId: handle.workflowRun.id,
                limit: 100,
              })
            ).data
            expect(
              attempts.filter(
                (attempt) =>
                  attempt.stepName ===
                    (boundary === "unborn push"
                      ? "claim-unborn-command"
                      : "acquire-revision") && attempt.status === "completed",
              ),
            ).toHaveLength(1)
            expect(
              attempts.filter(
                (attempt) =>
                  attempt.stepName ===
                  (boundary === "unborn push" ? "broker-push-unborn" : "stage"),
              ),
            ).toHaveLength(boundary === "semantic handoff" ? 1 : 2)
            if (boundary === "semantic handoff")
              expect(
                attempts.filter(
                  (attempt) => attempt.stepName === "capture-semantic-handoff",
                ),
              ).toHaveLength(2)
            expect(writeCredentials).toBe(1)
            expect(unexpectedRequests).toEqual([])
          }
          if (boundary === "semantic handoff") {
            const fault = await withHeldSemanticHandoffCommit(
              f.databaseUrl,
              jobId,
              exercise,
            )
            expect(fault.lostAcknowledgement).toBe(true)
          } else await exercise(f.databaseUrl)
        } catch (error) {
          const runs = await f.backend.listWorkflowRuns({ limit: 100 })
          const failures = await Promise.all(
            runs.data
              .filter((run) => run.workflowName.startsWith("workspace-write-"))
              .map(async (run) => ({
                name: run.workflowName,
                status: run.status,
                error: run.error,
                steps: (
                  await f.backend.listStepAttempts({
                    workflowRunId: run.id,
                    limit: 100,
                  })
                ).data.map((step) => ({
                  name: step.stepName,
                  status: step.status,
                  error: step.error,
                })),
              })),
          )
          childErrors += JSON.stringify(failures)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nNative child diagnostics: ${childErrors}`,
            { cause: error },
          )
        } finally {
          for (const child of children) await kill(child)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        }
      },
    )
  },
)
