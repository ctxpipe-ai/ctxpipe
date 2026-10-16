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
import { dockerRootExec, runAsRoot } from "./ingest-root.js"
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
  handle: SandboxHandle,
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
        )
        const contextSha = await containerRepo(
          handle,
          "/tmp/remotes/context.git",
          CONTEXT_FILES,
        )
        const hostSource = hostRepo(SOURCE_FILES)
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
          source: { url: "/tmp/remotes/source.git", sha: sourceSha },
          contexts: [
            { workspaceId: WORKSPACE_ID, url: "/tmp/remotes/context.git" },
          ],
          now: new Date("2026-10-01T00:00:00Z"),
        })
        expect(await ingestShardPrepared(root)).toBe(true)
        const heads = await root(
          `git -C /ctxpipe/source/source rev-parse HEAD && stat -c %U /ctxpipe/source/source /ctxpipe/context/${WORKSPACE_ID}`,
        )
        expect(heads.stdout.trim().split("\n")).toEqual([
          sourceSha,
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
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )
})
