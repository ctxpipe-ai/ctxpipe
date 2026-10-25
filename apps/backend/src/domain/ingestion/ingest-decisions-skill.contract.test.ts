import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import {
  ingestAgentCommand,
  ingestOpenCodeConfig,
  ingestOpenCodeEnv,
} from "./ingest-opencode.js"
import {
  collectIngestStep,
  prepareIngestSandbox,
  sealIngestCheckout,
  startIngestStep,
} from "./ingest-prepare.js"
import { dockerRootExec } from "./ingest-root.js"
import { validatePatchStep } from "./patch-validator.js"
import {
  INGEST_CONTEXT_ROOT,
  INGEST_HOME,
  INGEST_SKILLS_ROOT,
  INGEST_SOURCE_ROOT,
  readIngestSkillBundle,
} from "./skill-bundle.js"

/*
 * Contract (Docker): the `decisions` skill in the ingest sandbox. The agent
 * user runs the script on a sealed source checkout, plays the model with fixed
 * writes through the stage helpers, runs the check, and the host validator
 * accepts the collected staged tree. The model run itself is not part of this
 * test: the deterministic part is the script, the check, and the validator.
 */

const SOURCE_URL = "https://github.com/example-org/shop"
// The source file of SOURCE_URL in the Workspace: the value of `sources`.
const SOURCE_PATH = "sources/github/example-org/shop.md"
const WORKSPACE_ID = "ws_contract"
const CONTEXT_DIR = `${INGEST_CONTEXT_ROOT}/${WORKSPACE_ID}`
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

let host: string
beforeAll(() => {
  host = mkdtempSync(join(tmpdir(), "ingest-decisions-contract-"))
})
afterAll(() => {
  rmSync(host, { recursive: true, force: true })
})

describe("decisions skill in the sandbox", () => {
  it("writes a staged tree that the host validator accepts, and the check passes", async () => {
    const provider = dockerSandbox({ image: workspaceChatDockerImage() })
    const handle = await provider.create({
      id: `ingest-decisions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    try {
      const sh = async (command: string) => {
        const result = await handle.process.exec(command, { env: GIT_ENV })
        if (result.exitCode !== 0)
          throw new Error(`${command}\n${result.stdout}\n${result.stderr}`)
        return result.stdout
      }
      const root = dockerRootExec(handle.id)
      const bundle = await readIngestSkillBundle()
      await prepareIngestSandbox(handle, root, {
        bundle,
        opencodeConfig: ingestOpenCodeConfig({
          modelBase: "stub",
          models: [],
          skills: bundle.skills,
          proxyAddsCredentials: true,
          toolBridgeUrl: "http://127.0.0.1:9/tool-bridge",
        }),
      })
      expect(bundle.skills).toContain("decisions")
      const agent = (command: string) =>
        root(
          ingestAgentCommand({
            env: ingestOpenCodeEnv({ path: "/usr/local/bin:/usr/bin:/bin" }),
            command,
          }),
        )
      const seal = async (
        kind: "context" | "source",
        id: string,
        files: Record<string, string>,
      ) => {
        const from = `/tmp/clone-${kind}-${id}`
        for (const [path, content] of Object.entries(files)) {
          const full = `${from}/${path}`
          await sh(`mkdir -p ${quote(full.slice(0, full.lastIndexOf("/")))}`)
          await handle.fs.write(full, content)
        }
        await sh(
          `cd ${from} && git init -q -b main && git add -A && git commit -q --allow-empty -m base`,
        )
        return sealIngestCheckout(root, { kind, id, from })
      }
      await seal("source", "shop", {
        "package.json": JSON.stringify({ name: "shop", private: true }),
        "apps/api/README.md": "# API\n",
        "docs/adr/0001-use-postgres.md":
          "# 1. Use Postgres\n\nStatus: Accepted\n\nWe store orders (`apps/api/README.md`) in Postgres.\n",
        "docs/adr/0002-use-cockroach.md":
          "# 2. Use CockroachDB\n\nStatus: Accepted\n\nSupersedes ADR-1.\n",
      })
      const source = `${INGEST_SOURCE_ROOT}/shop`
      await seal("context", WORKSPACE_ID, {
        "README.md": "# Context\n",
        "knowledge/services/api.md": `---\nkind: Service\nname: API\ngenerated_by: ctxpipe-extract\nsources:\n  - ${SOURCE_PATH}\n---\n# API\n`,
      })
      const baseCommit = (
        await sh(`git -C ${CONTEXT_DIR} rev-parse HEAD`)
      ).trim()
      await startIngestStep(root, {
        workspaceId: WORKSPACE_ID,
        baseCommit,
        index: JSON.stringify({
          entries: [
            {
              path: "knowledge/services/api.md",
              kind: "Service",
              title: "API",
              summary: null,
              links: [],
              sources: [SOURCE_PATH],
              owned: true,
            },
          ],
        }),
      })
      const run = async (command: string) => {
        const r = await agent(command)
        return { code: r.exitCode, out: r.stdout, err: r.stderr }
      }
      const roots = {
        roots: [
          {
            path: "apps/api",
            manifests: [],
            evidence: [],
            files: ["knowledge/services/api.md"],
          },
        ],
      }
      await agent(
        `printf %s ${quote(Buffer.from(JSON.stringify(roots)).toString("base64"))} | base64 -d > ${INGEST_HOME}/roots.json`,
      )
      const script = `node ${INGEST_SKILLS_ROOT}/decisions/scripts/decisions.mjs --source ${source} --source-url ${SOURCE_URL} --source-path ${SOURCE_PATH} --roots ${INGEST_HOME}/roots.json`
      const listed = await run(script)
      expect(listed.code, listed.err).toBe(0)
      const result = JSON.parse(listed.out) as {
        decisions: Array<{
          path: string
          name: string
          status: string
          target: string
          influences: string[]
          supersedes: Array<{ to: string; evidence: string }>
        }>
      }
      expect(result.decisions.map((d) => d.path)).toEqual([
        "docs/adr/0001-use-postgres.md",
        "docs/adr/0002-use-cockroach.md",
      ])
      for (const d of result.decisions) {
        const claims = [
          ...d.influences.map(
            (to) =>
              `  - to: ${JSON.stringify(to)}\n    predicate: INFLUENCES\n    evidence:\n      path: ${JSON.stringify(d.path)}\n      kind: script`,
          ),
          ...d.supersedes.map(
            (s) =>
              `  - to: ${JSON.stringify(s.to)}\n    predicate: SUPERSEDES\n    evidence:\n      path: ${JSON.stringify(s.evidence)}\n      kind: script`,
          ),
        ]
        const text = `---\nkind: Decision\nname: ${JSON.stringify(d.name)}\nsummary: "A decision."\nclaims:\n${claims.join("\n")}\n---\n# ${d.name}\n\n**Status:** ${d.status[0]?.toUpperCase()}${d.status.slice(1)}\n**Source:** \`${d.path}\`\n\n## Decision\n\nThe team chose this.\n`
        const staged = await run(`ctxpipe-stage ${d.target}`)
        expect(staged.code, staged.err).toBe(0)
        await agent(
          `printf %s ${quote(Buffer.from(text).toString("base64"))} | base64 -d > /ctxpipe/out/files/${d.target}`,
        )
      }
      const checked = await run(`${script} --check`)
      expect(checked.code, checked.out + checked.err).toBe(0)
      expect((await run("ctxpipe-finish")).code).toBe(0)

      const output = await collectIngestStep(handle, root)
      const dir = mkdtempSync(join(host, "step-"))
      writeFileSync(join(dir, "step.tar"), output)
      mkdirSync(join(dir, "step"))
      execFileSync("tar", [
        "-xf",
        join(dir, "step.tar"),
        "-C",
        join(dir, "step"),
      ])
      await sh(
        `git -C ${CONTEXT_DIR} bundle create /tmp/context.bundle HEAD >/dev/null 2>&1`,
      )
      writeFileSync(
        join(dir, "context.bundle"),
        await handle.fs.readBytes("/tmp/context.bundle"),
      )
      const repo = join(dir, "context")
      execFileSync("git", ["init", "-q", "--bare", repo])
      execFileSync("git", [
        "-C",
        repo,
        "fetch",
        "-q",
        join(dir, "context.bundle"),
        "HEAD:refs/heads/base",
      ])
      const validated = await validatePatchStep({
        repoDir: repo,
        baseCommit,
        stagedDir: join(dir, "step"),
        source: { url: SOURCE_URL, sha: "a".repeat(40) },
        sourcePath: SOURCE_PATH,
        skill: "decisions",
        bundle: bundle.name,
        sourcePathExists: async () => true,
        readSourceFile: async () => null,
        linkableRepositories: [SOURCE_URL],
      })
      expect(validated.rejections).toEqual([])
      expect(validated.accepted.map((op) => op.path).sort()).toEqual(
        result.decisions.map((d) => d.target).sort(),
      )
    } finally {
      await provider.destroy({ id: handle.id })
    }
  }, 300_000)
})
