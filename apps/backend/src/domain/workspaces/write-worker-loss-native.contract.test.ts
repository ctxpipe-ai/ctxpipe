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
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getWriteJobCommitSha } from "../../models/workspace-write-jobs.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

it(
  "two replacement processes recover a killed writer after its temporary Git checkout is lost",
  { timeout: 100_000 },
  async () => {
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
initDb(process.env.DATABASE_URL);
const backend = await BackendPostgres.connect(process.env.DATABASE_URL, { namespaceId: ${JSON.stringify(f.id)}, runMigrations: false });
const runner = new OpenWorkflow({ backend });
runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn);
const worker = runner.newWorker({ concurrency: 1 });
await worker.start();
await new Promise(() => {});
`,
        )
        const ready = join(f.directory, "staging-interrupted")
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
if (result.status === 0 && args.includes("hash-object") && !existsSync(${JSON.stringify(ready)})) {
  writeFileSync(${JSON.stringify(ready)}, args[args.indexOf("-C") + 1]);
  while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
process.exit(result.status ?? 1);
`,
          { mode: 0o700 },
        )
        const children: Array<{ child: ChildProcess; exited: Promise<void> }> =
          []
        let childErrors = ""
        const launch = (crash: boolean) => {
          const child = spawn("bun", [script], {
            cwd: f.directory,
            detached: true,
            env: {
              ...process.env,
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
          const handle = await f.runner.runWorkflow(workspaceBootstrap.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            revision: { ...f.revision, access: "write-default" },
          })
          const original = launch(true)
          await expect
            .poll(() => existsSync(ready), {
              timeout: 20_000,
              message: "The original native worker must reach real Git staging",
            })
            .toBe(true)
          await kill(original)
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
              `${f.sha}..main`,
            ),
          ).toBe("1")
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
                attempt.stepName === "acquire-revision" &&
                attempt.status === "completed",
            ),
          ).toHaveLength(1)
          expect(
            attempts.filter((attempt) => attempt.stepName === "stage"),
          ).toHaveLength(2)
          expect(writeCredentials).toBe(1)
          expect(unexpectedRequests).toEqual([])
        } catch (error) {
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
