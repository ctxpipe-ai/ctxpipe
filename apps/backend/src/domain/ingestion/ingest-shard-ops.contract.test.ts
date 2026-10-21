import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import { ingestOpenCodeConfig } from "./ingest-opencode.js"
import { collectIngestStep } from "./ingest-prepare.js"
import {
  dockerRootExec,
  ROOT_STDOUT_MAX_BYTES,
  runAsRoot,
} from "./ingest-root.js"
import {
  discoverIngestRoots,
  ingestAgentEnv,
  ingestShardPrepared,
  prepareIngestShard,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import { withIngestStepOutput } from "./ingest-step-output.js"
import { gitSource, validatePatchStep } from "./patch-validator.js"
import { readIngestSkillBundle } from "./skill-bundle.js"

/*
 * Contract (Docker): the shard commands of the ingest runtime in a real chat
 * sandbox image. Prepare clones the source and the context repository and
 * seals them; discover-roots runs the bundle script as the agent; a script
 * skill stages a file that the host validator accepts; a later step fetches
 * the shard ref first. The remotes are local repositories in the container;
 * the closed egress of a real shard is the T03 contract.
 */

const SOURCE_URL = "https://github.com/example-org/checkout-api"
// The source file of SOURCE_URL in the Workspace: the value of `sources`.
const SOURCE_PATH = "sources/github/example-org/checkout-api.md"
const WORKSPACE_ID = "ws_contract"
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
}
const SOURCE_FILES: Record<string, string> = {
  "package.json": '{ "name": "checkout-api" }\n',
  "services/orders/package.json": '{ "name": "orders" }\n',
  "services/orders/src/index.ts": "export const orders = []\n",
}
const CONTEXT_FILES: Record<string, string> = { "README.md": "# Context\n" }
/**
 * A first source commit older than the 180-day window: the source clone is
 * shallow, and it has no blob of this commit.
 */
const OLD_SOURCE_FILES: Record<string, string> = {
  "package.json": '{ "name": "checkout-api", "private": true }\n',
}
const OLD_DATE = {
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
}
/** A script skill of the plan: it stages one library file for its root. */
const LIBRARIES_SCRIPT = `#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
const out = execFileSync("ctxpipe-stage", ["knowledge/libraries/orders.md"]).toString()
const path = out.trim().split(" ").pop()
writeFileSync(path, "---\\nkind: Library\\nname: orders\\n---\\n# orders\\n\\nThe library of " + process.env.CTXPIPE_ROOT + " in " + process.env.CTXPIPE_SOURCE + ".\\n")
`

let host: string
let bundleDir: string

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The same commits on the host and in the container: fixed dates and author. */
function hostRepo(
  files: Record<string, string>,
  old?: Record<string, string>,
): { dir: string; sha: string } {
  const dir = mkdtempSync(join(host, "repo-"))
  const write = (tree: Record<string, string>) => {
    for (const [path, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
  }
  const git = (args: string[], dates = {}) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV, ...dates },
    }).trim()
  git(["init", "-q", "-b", "main"])
  if (old) {
    write(old)
    git(["add", "-A"])
    git(["commit", "-q", "-m", "old"], OLD_DATE)
  }
  write(files)
  git(["add", "-A"])
  git(["commit", "-q", "-m", "seed"])
  return { dir, sha: git(["rev-parse", "HEAD"]) }
}

async function containerRepo(
  handle: SandboxHandle,
  remote: string,
  files: Record<string, string>,
  old?: Record<string, string>,
): Promise<string> {
  const work = `${remote}.work`
  const commit = async (
    tree: Record<string, string>,
    message: string,
    dates = {},
  ) => {
    for (const [path, content] of Object.entries(tree)) {
      await handle.process.exec(`mkdir -p ${quote(dirname(`${work}/${path}`))}`)
      await handle.fs.write(`${work}/${path}`, content)
    }
    const result = await handle.process.exec(
      `cd ${work} && git add -A && git commit -q -m ${message}`,
      { env: { ...GIT_ENV, ...dates } },
    )
    if (result.exitCode !== 0) throw new Error(result.stderr)
  }
  await handle.process.exec(
    `mkdir -p ${work} && git -C ${work} init -q -b main`,
  )
  if (old) await commit(old, "old", OLD_DATE)
  await commit(files, "seed")
  // The remote allows a filter, as GitHub does, so a blobless clone of it
  // is partial.
  const result = await handle.process.exec(
    `git clone -q --bare ${work} ${remote} && git -C ${remote} config uploadpack.allowFilter true && git -C ${work} rev-parse HEAD`,
  )
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

beforeAll(async () => {
  host = mkdtempSync(join(tmpdir(), "ingest-shard-ops-"))
  const real = await readIngestSkillBundle()
  bundleDir = join(host, "bundle")
  for (const file of real.files) {
    mkdirSync(dirname(join(bundleDir, file.path)), { recursive: true })
    writeFileSync(join(bundleDir, file.path), file.content, {
      mode: file.executable ? 0o755 : 0o644,
    })
  }
  mkdirSync(join(bundleDir, "libraries/scripts"), { recursive: true })
  writeFileSync(
    join(bundleDir, "libraries/SKILL.md"),
    "---\nname: libraries\ndescription: Fixture script skill.\n---\n# libraries\n",
  )
  writeFileSync(
    join(bundleDir, "libraries/scripts/libraries.mjs"),
    LIBRARIES_SCRIPT,
  )
})

afterAll(() => {
  rmSync(host, { recursive: true, force: true })
})

describe("ingest shard commands in a Docker sandbox", () => {
  it(
    "prepares the checkouts, discovers the roots, and runs a script step on the fetched shard ref",
    { timeout: 300_000 },
    async () => {
      const bundle = await readIngestSkillBundle(bundleDir)
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-ops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        // Root fetches from the default user's local remotes in this test.
        await runAsRoot(root, "git config --system --add safe.directory '*'")
        const sourceSha = await containerRepo(
          handle,
          "/tmp/remotes/source.git",
          SOURCE_FILES,
          OLD_SOURCE_FILES,
        )
        const contextSha = await containerRepo(
          handle,
          "/tmp/remotes/context.git",
          CONTEXT_FILES,
        )
        const hostSource = hostRepo(SOURCE_FILES, OLD_SOURCE_FILES)
        const hostContext = hostRepo(CONTEXT_FILES)
        expect([sourceSha, contextSha]).toEqual([
          hostSource.sha,
          hostContext.sha,
        ])

        const agentEnv = await ingestAgentEnv(root, {
          modelProxyUrl: "http://127.0.0.1:9/v1",
        })
        expect(await ingestShardPrepared(root)).toBe(false)
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
          // A file URL: git ignores the filter and the history window for
          // a plain path, so only this clone is shallow and blobless.
          source: {
            url: "file:///tmp/remotes/source.git",
            sha: sourceSha,
            blobless: true,
          },
          contexts: [
            { workspaceId: WORKSPACE_ID, url: "/tmp/remotes/context.git" },
          ],
          now: new Date("2026-10-01T00:00:00Z"),
        })
        expect(await ingestShardPrepared(root)).toBe(true)
        const heads = await root(
          `git -C /ctxpipe/source/source rev-parse HEAD --is-shallow-repository && stat -c %U /ctxpipe/source/source /ctxpipe/context/${WORKSPACE_ID}`,
        )
        expect(heads.stdout.trim().split("\n")).toEqual([
          sourceSha,
          "true",
          "root",
          "root",
        ])

        // No workspace manifest names `services/orders`, so the script keeps
        // the repository root and gives the folder to the model to choose.
        expect(await discoverIngestRoots(root, agentEnv)).toEqual({
          roots: [{ path: ".", manifests: ["package.json"], evidence: ["."] }],
          ambiguous: [
            {
              manifest: null,
              reason: "No workspace manifest names these folders",
              candidates: [
                { path: "services/orders", manifests: ["package.json"] },
              ],
            },
          ],
          skipped: [],
        })

        const step = {
          name: `skill:repository:libraries:${WORKSPACE_ID}`,
          skill: "libraries",
          run: "script" as const,
          root: null,
          workspaceId: WORKSPACE_ID,
          baseCommit: contextSha,
          rootMap: { roots: [] },
          signal: AbortSignal.timeout(120_000),
        }
        await runIngestShardStep(root, {
          step,
          agentEnv,
          remote: "/tmp/remotes/context.git",
          sourceUrl: SOURCE_URL,
          sourcePath: SOURCE_PATH,
          index: '{"entries":[]}',
        })
        const tar = await collectIngestStep(handle, root)
        const result = await withIngestStepOutput(tar, (stagedDir) =>
          validatePatchStep({
            repoDir: hostContext.dir,
            baseCommit: contextSha,
            stagedDir,
            source: { url: SOURCE_URL, sha: sourceSha },
            sourcePath: SOURCE_PATH,
            skill: "libraries",
            bundle: bundle.name,
            ...gitSource(hostSource.dir, hostSource.sha),
          }),
        )
        expect(result.rejections).toEqual([])
        expect(result.accepted).toEqual([
          { op: "create", path: "knowledge/libraries/orders.md" },
        ])

        // The next step starts at the shard ref tip, which only the remote has.
        const ref = `refs/ctxpipe/ingest/run_contract/${WORKSPACE_ID}/shards/0`
        const pushed = await handle.process.exec(
          `cd /tmp/remotes/context.git.work && git commit -q --allow-empty -m step && git push -q /tmp/remotes/context.git HEAD:${ref} && git rev-parse HEAD`,
          { env: GIT_ENV },
        )
        expect(pushed.exitCode, pushed.stderr).toBe(0)
        const tip = pushed.stdout.trim()
        await runIngestShardStep(root, {
          step: { ...step, baseCommit: tip, fetchRef: ref },
          agentEnv,
          remote: "/tmp/remotes/context.git",
          sourceUrl: SOURCE_URL,
          sourcePath: SOURCE_PATH,
        })
        const at = await root(
          `git -C /ctxpipe/context/${WORKSPACE_ID} rev-parse HEAD && cat /ctxpipe/step.json`,
        )
        expect(at.stdout).toContain(tip)
        expect(at.stdout).toContain(`"baseCommit":"${tip}"`)

        // A large root map with non-ASCII roots: a part boundary falls
        // inside multi-byte characters, also inside a surrogate pair.
        const rootMap = {
          roots: Array.from({ length: 400 }, (_, i) => ({
            path: `services/größe-日本-😀-${i}`,
            manifests: [`services/größe-日本-😀-${i}/package.json`],
            evidence: ["😀".repeat(40)],
            files: [`knowledge/libraries/ü-${i}.md`],
          })),
        }
        await runIngestShardStep(root, {
          step: { ...step, baseCommit: tip, fetchRef: ref, rootMap },
          agentEnv,
          remote: "/tmp/remotes/context.git",
          sourceUrl: SOURCE_URL,
          sourcePath: SOURCE_PATH,
        })
        const written = await handle.fs.readBytes("/ctxpipe/roots.json")
        expect(Buffer.from(written).toString("utf8")).toBe(
          JSON.stringify(rootMap),
        )

        // A step that writes more than the tar cap into /ctxpipe/out: the
        // sandbox refuses the tar, so the host never reads it (CTX-971).
        await runAsRoot(
          root,
          "head -c 5242880 /dev/urandom > /ctxpipe/out/files/large.bin",
        )
        await expect(collectIngestStep(handle, root)).rejects.toThrow(
          /The step output is \d+ bytes; the limit is 4194304 bytes/,
        )

        // A command that writes 32 MiB of short lines through the Docker
        // stream: the worker keeps only the start of stdout (CTX-971).
        const noisy = await root("yes | head -c 33554432")
        expect(noisy.exitCode).toBe(0)
        expect(noisy.stdoutTruncated).toBe(true)
        expect(Buffer.byteLength(noisy.stdout)).toBe(ROOT_STDOUT_MAX_BYTES)
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )

  it(
    "stops the plain git clone of prepare at the step's signal when the git host sends nothing, and sets the low speed limit on the clone",
    { timeout: 300_000 },
    async () => {
      const bundle = await readIngestSkillBundle(bundleDir)
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-ops-stall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        // A git host that accepts the connection and never answers.
        const silent = await handle.process.spawn(
          `node -e "require('net').createServer(() => {}).listen(9418, '127.0.0.1', () => console.log('ready'))"`,
        )
        for await (const chunk of silent.stdout)
          if (chunk.includes("ready")) break
        const commands: string[] = []
        const recorded: Pick<SandboxHandle, "fs" | "process"> = {
          fs: handle.fs,
          process: {
            exec: (command, options) => {
              commands.push(command)
              return handle.process.exec(command, options)
            },
            spawn: (command, options) => handle.process.spawn(command, options),
          },
        }
        const agentEnv = await ingestAgentEnv(root, {
          modelProxyUrl: "http://127.0.0.1:9/v1",
        })
        const controller = new AbortController()
        const started = Date.now()
        const outcome = prepareIngestShard(recorded, root, {
          bundle,
          opencodeConfig: ingestOpenCodeConfig({
            modelBase: "stub",
            models: [],
            skills: bundle.skills,
            proxyAddsCredentials: true,
            toolBridgeUrl: "http://127.0.0.1:9/tool-bridge",
          }),
          agentEnv,
          source: {
            url: "http://127.0.0.1:9418/team/app.git",
            sha: "a".repeat(40),
            blobless: false,
          },
          contexts: [],
          now: new Date("2026-10-01T00:00:00Z"),
          signal: controller.signal,
        }).then(
          () => "prepared",
          (error: unknown) => String(error),
        )
        // Abort while the clone waits; git's low speed limit (60 s) and the
        // step limit (10 min) are both later.
        await new Promise((resolve) => setTimeout(resolve, 15_000))
        const clone = commands.find((command) =>
          command.includes("127.0.0.1:9418"),
        )
        controller.abort(new Error("The ingest step reached its time limit"))
        expect(await outcome).not.toBe("prepared")
        expect(Date.now() - started).toBeLessThan(45_000)
        expect(await ingestShardPrepared(root)).toBe(false)
        expect(clone).toContain(
          "git clone -q -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 --no-checkout",
        )
        await silent.kill()
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )
})
