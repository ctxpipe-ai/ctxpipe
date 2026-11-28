import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The eval checks: the smoke tier of OrgBench (lane `bench`, CTX-1665). It
// costs model money, so it is stochastic, and its manifest entry has
// `selectBy: "inputs"`: a selector selects it only when a file of the tool
// surface changes (its `inputs`), by no other rule and no model step. As a
// stochastic check, it has no key and stores no pass. The paid run is not
// this check: the smoke tier of `apps/backend/evals/bench/run.py` runs on the
// host with the model key and keeps one verdict for each hash of the tool
// surface. This check reads the verdict of the tool surface of the checkout.
// Usage:
//   evals.mjs surface   prints the files and the hash of the tool surface

const root = fileURLToPath(new URL("../../", import.meta.url))
const tiers = "apps/backend/evals/bench/tiers.json"

// The tool surface that the CTX arm sees: each MCP tool with its name,
// description and input schema, the tool registry and framework, and the
// agent guidance of the plugin. Tests and latency checks are not part of it.
const surfaceRoots = [
  "apps/backend/src/mcp/tools.ts",
  "apps/backend/src/mcp/tools",
  "apps/backend/src/mcp/framework",
  "plugins/ctxpipe/skills",
]
const notSurface = /\.(test|latency|intent)\./

function walk(path) {
  if (!statSync(join(root, path)).isDirectory()) return [path]
  return readdirSync(join(root, path))
    .sort()
    .flatMap((name) => walk(`${path}/${name}`))
}

function surfaceFiles() {
  return surfaceRoots
    .flatMap(walk)
    .filter((path) => !notSurface.test(path))
    .sort()
}

// The hash of the tool surface: each path and its bytes, in path order.
function surfaceHash(files = surfaceFiles()) {
  const hash = createHash("sha256")
  for (const path of files)
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(join(root, path)))
      .update("\0")
  return hash.digest("hex")
}

// The verdict file of the smoke tier for a hash (run.py writes it).
const smokeVerdictPath = (hash) =>
  join(homedir(), ".cache", "ctxpipe-bench", "smoke", `${hash}.json`)

export function listEvals() {
  return [
    {
      id: `eval:bench:${tiers}#smoke`,
      family: "eval",
      lane: "bench",
      root: "apps/backend/evals/bench",
      file: tiers,
      inputs: surfaceFiles(),
      selectBy: "inputs",
      stochastic: true,
      portable: true,
      prerequisites: ["bench-smoke"],
      intent:
        "Catches a change of the MCP tool surface (a tool, its name, description or input schema, the registry, the agent guidance) that breaks a real agent: own-service errors, argument errors, no tool use. Never for any other change.",
    },
  ]
}

// The `bench-smoke` prerequisite: the smoke tier has a verdict for the tool
// surface of this checkout.
export function verifySmokeVerdict() {
  const hash = surfaceHash()
  if (!existsSync(smokeVerdictPath(hash)))
    throw new Error(
      `No smoke verdict for the tool surface ${hash.slice(0, 12)} of this checkout. Start a local stack of this checkout, then run the smoke tier against it (apps/backend/evals/bench/README.md, "The smoke check"): it costs at most $3 of model spend, and it runs once for each tool surface.`,
    )
}

// Runs the smoke check: the verdict of the smoke tier for the tool surface
// of the checkout.
export function runEvals(checks) {
  return {
    records: checks.map(({ id }) => {
      const hash = surfaceHash()
      const verdict = JSON.parse(readFileSync(smokeVerdictPath(hash), "utf8"))
      const numbers = Object.entries(verdict.numbers ?? {})
        .map(([name, value]) => `${name} ${value}`)
        .join(", ")
      return {
        id,
        status: verdict.pass ? "passed" : "failed",
        durationMs: 0,
        cases: [],
        message: `Smoke tier for the tool surface ${hash.slice(0, 12)}: ${verdict.pass ? "pass" : `fail (${verdict.reasons.join("; ")})`}; ${numbers}; MCP ${verdict.mcpUrl}; run folder ${verdict.runFolder}`,
      }
    }),
  }
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "surface"
) {
  const files = surfaceFiles()
  process.stdout.write(
    `${JSON.stringify({ hash: surfaceHash(files), files })}\n`,
  )
}
