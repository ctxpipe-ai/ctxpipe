import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { graphReady } from "../ci/graph-ready.mjs"

// The named prerequisites of checks (the `prerequisites` of a manifest
// record). Each one makes a thing or verifies it, and throws an error with
// the fix when it cannot. Usage:
//   prerequisites.mjs <name>...   (pnpm checks:prepare)
// The runner (run.mjs) calls `prepare` for the prerequisites of the checks
// that it runs. Command output goes to stderr: stdout of the runner carries
// only result records.

const root = fileURLToPath(new URL("../../", import.meta.url))
const backend = createRequire(join(root, "apps/backend/package.json"))

// Runs a command with its output on stderr. Throws `fix` when it fails.
const step = (command, args, fix, cwd = root) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ["ignore", 2, 2],
    timeout: 1_800_000,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}). ${fix}`,
    )
}
const quiet = (command, args, fix) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    }).trim()
  } catch {
    throw new Error(`${command} ${args.join(" ")} failed. ${fix}`)
  }
}
const required = (name, fix) => {
  if (!process.env[name]) throw new Error(`${name} is not set. ${fix}`)
  return process.env[name]
}
const declared = (file, pattern) => {
  const value = readFileSync(join(root, file), "utf8").match(pattern)?.[1]
  if (!value) throw new Error(`Cannot read ${pattern} from ${file}`)
  return value
}
const pgQuery = async (sql) => {
  const { Pool } = backend("pg")
  const pool = new Pool({
    connectionString: required(
      "DATABASE_URL",
      "Start Postgres (pnpm dev:infra) and set DATABASE_URL.",
    ),
    connectionTimeoutMillis: 5_000,
  })
  try {
    return (await pool.query(sql)).rows
  } finally {
    await pool.end()
  }
}
const answers = async (url, fix) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return response.status
  } catch (error) {
    throw new Error(`${url} does not answer (${error.message}). ${fix}`)
  }
}
const workbenchFix =
  "Evals call paid models, so they run only with the workbench environment: set MODEL_PROVIDER_API_KEY (the spend-capped workbench key) and MCP_EVAL_MODELS (two or more provider/model ids, comma-separated)."

// Each entry: `needs` (other prerequisites, made first) and `prepare` (makes
// or verifies). Keep this a small map; it is not a build system.
export const prerequisites = {
  bun: {
    prepare: () =>
      quiet("bun", ["--version"], "Install Bun (package.json engines)."),
  },
  docker: {
    prepare: () => quiet("docker", ["info"], "Start Docker."),
  },
  "ast-grep": {
    prepare: () =>
      quiet(
        "ast-grep",
        ["--version"],
        "npm install --global @ast-grep/cli@0.45.0",
      ),
  },
  zoekt: {
    prepare: () => {
      for (const binary of ["zoekt-index", "zoekt-webserver"])
        try {
          execFileSync(binary, ["-h"], { stdio: "ignore", timeout: 10_000 })
        } catch {
          throw new Error(
            `${binary} is missing. Install zoekt as the CI step "Required native revision index tools" does.`,
          )
        }
    },
  },
  opencode: {
    prepare: () => {
      const expected = declared(
        "apps/backend/src/domain/workspaces/workspace-chat-opencode-contract.ts",
        /WORKSPACE_CHAT_OPENCODE_CLI = "opencode-ai@([^"]+)"/,
      )
      const found = quiet(
        "opencode",
        ["--version"],
        `npm install --global opencode-ai@${expected}`,
      )
      if (found !== expected)
        throw new Error(
          `OpenCode must be ${expected}; found ${found}. npm install --global opencode-ai@${expected}`,
        )
    },
  },
  postgres: {
    prepare: () => pgQuery("SELECT 1"),
  },
  migrations: {
    needs: ["postgres"],
    prepare: async () => {
      const [row] = await pgQuery(
        "SELECT to_regclass('public.workspaces') AS workspaces, to_regclass('openworkflow.workflow_runs') AS workflows",
      )
      if (!row?.workspaces || !row.workflows)
        throw new Error(
          "The database at DATABASE_URL has no migrations. Run pnpm db:migrate.",
        )
    },
  },
  falkordb: {
    prepare: () =>
      graphReady(
        required(
          "GRAPH_DB_URI",
          "Start FalkorDB (pnpm dev:infra) and set GRAPH_DB_URI.",
        ),
      ),
  },
  "chat-sandbox-image": {
    needs: ["docker"],
    prepare: () => {
      const tag = declared(
        "apps/backend/src/domain/workspaces/chat-runtime.ts",
        /"(ctxpipe-chat-sandbox:[^"]+)"/,
      )
      const inspect = spawnSync("docker", ["image", "inspect", tag], {
        stdio: "ignore",
      })
      if (inspect.status !== 0)
        step(
          "docker",
          ["build", "-t", tag, "scripts/chat-sandbox"],
          "See scripts/chat-sandbox/README.md.",
        )
    },
  },
  chromium: {
    prepare: () =>
      step(
        "pnpm",
        ["exec", "playwright", "install", "chromium"],
        "Install the Playwright Chromium.",
        join(root, "apps/ui"),
      ),
  },
  // CI downloads the build of its Storybook job and sets
  // SKIP_STORYBOOK_BUILD=1, as for scripts/ci/storybook-golden.mjs.
  "storybook-build": {
    prepare: () => {
      if (process.env.SKIP_STORYBOOK_BUILD !== "1")
        step(
          "pnpm",
          ["--filter", "@ctxpipe/ui", "build-storybook"],
          "Fix the Storybook build.",
        )
      if (!existsSync(join(root, "apps/ui/storybook-static/index.json")))
        throw new Error(
          "apps/ui/storybook-static/index.json is missing. Unset SKIP_STORYBOOK_BUILD to build Storybook.",
        )
    },
  },
  "previous-release": {
    prepare: () => {
      const tree = required(
        "RELEASE_TREE",
        "Check out the previous release with its dependencies, as the CI job upgrade-from-previous-release does, and set RELEASE_TREE to it.",
      )
      if (!existsSync(join(tree, "apps/backend/node_modules")))
        throw new Error(
          `RELEASE_TREE ${tree} has no apps/backend/node_modules. Run pnpm install --frozen-lockfile --filter "@ctxpipe/backend..." in it.`,
        )
    },
  },
  workbench: {
    prepare: () => {
      required("MODEL_PROVIDER_API_KEY", workbenchFix)
      const models = required("MCP_EVAL_MODELS", workbenchFix)
      if (new Set(models.split(",").filter(Boolean)).size < 2)
        throw new Error(
          `MCP_EVAL_MODELS names fewer than two models. ${workbenchFix}`,
        )
    },
  },
  "codesearch-server": {
    prepare: () =>
      answers(
        required("CODESEARCH_URL", "Start codesearch and set CODESEARCH_URL."),
        "Start codesearch (pnpm dev, or scripts/codesearch-host-dev.sh).",
      ),
  },
  // The backend of this checkout, at its own base URL (AUTH_BASE_URL).
  "mcp-server": {
    prepare: async () => {
      const base = required(
        "AUTH_BASE_URL",
        "Start the backend of this checkout and set AUTH_BASE_URL to its base URL.",
      )
      const status = await answers(
        new URL("/mcp", base).href,
        "Start the backend of this checkout (pnpm dev).",
      )
      if (status !== 401 && (status < 200 || status > 299))
        throw new Error(`${base}/mcp answers ${status}, not an MCP endpoint.`)
    },
  },
  "memory-live-runner": {
    prepare: () => {
      throw new Error(
        "The live runner of the memory evals is not implemented yet (packages/cli/test/memory/evals/README.md).",
      )
    },
  },
  "aws-cdk-image-tag": {
    prepare: () =>
      step(
        process.execPath,
        ["packages/aws-cdk/scripts/stamp-image-tag.mjs"],
        "Fix the image tag stamp.",
      ),
  },
  "aws-cdk-build": {
    prepare: () =>
      step(
        "pnpm",
        ["--filter", "@ctxpipe/aws-cdk", "build"],
        "Fix the @ctxpipe/aws-cdk build.",
      ),
  },
  "docs-mdx": {
    prepare: () =>
      step(
        "pnpm",
        ["--filter", "@ctxpipe/docs", "exec", "fumadocs-mdx"],
        "Fix the docs content.",
      ),
  },
}

// Makes or verifies the named prerequisites and the ones that they need,
// each once, in order. Returns a map from each name to its error message;
// a name whose prerequisite failed fails too, and is not tried.
export async function prepare(names) {
  const failed = new Map()
  const done = new Set()
  const visit = async (name) => {
    if (done.has(name)) return
    done.add(name)
    const entry = prerequisites[name]
    if (!entry) {
      failed.set(name, `Unknown prerequisite ${name}`)
      return
    }
    for (const need of entry.needs ?? []) {
      await visit(need)
      if (failed.has(need)) {
        failed.set(name, `needs ${need}: ${failed.get(need)}`)
        return
      }
    }
    process.stderr.write(`Prerequisite ${name}\n`)
    try {
      await entry.prepare()
    } catch (error) {
      failed.set(name, error.message)
    }
  }
  for (const name of [...new Set(names)].sort()) await visit(name)
  return failed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2)
  if (!names.length) {
    process.stderr.write(
      `Usage: prerequisites.mjs <name>...\nNames: ${Object.keys(prerequisites).join(", ")}\n`,
    )
    process.exitCode = 1
  } else {
    const failed = await prepare(names)
    for (const name of names)
      process.stdout.write(
        failed.has(name)
          ? `failed ${name}: ${failed.get(name)}\n`
          : `ready ${name}\n`,
      )
    // A socket (FalkorDB, Postgres) can keep the event loop alive, so exit
    // once stdout has the lines.
    process.stdout.write("", () => process.exit(failed.size ? 1 : 0))
  }
}
