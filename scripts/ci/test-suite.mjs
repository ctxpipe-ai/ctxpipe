import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const packages = {
  backend: "apps/backend",
  contracts: "apps/backend",
  vercel: "apps/backend",
  ui: "apps/ui",
  cli: "packages/cli",
  "aws-cdk": "packages/aws-cdk",
}
try {
  const [name, ...extra] = process.argv.slice(2)
  const listOnly = extra.length === 1 && extra[0] === "--list"
  if (!packages[name] || (extra.length && !listOnly))
    throw new Error(
      "Usage: test-suite.mjs backend|contracts|vercel|ui|cli|aws-cdk [--list]",
    )
  const cwd = join(root, packages[name])
  const run = (script, args = [], directory = root) => {
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd: directory,
      stdio: "inherit",
    })
    if (result.status !== 0) throw new Error(`${script} failed`)
  }
  const baseline = `scripts/ci/failures/${name}.json`
  let files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file))
  if (!files.length) throw new Error(`No required tests found for ${name}`)
  let selection = []
  if (name === "backend" || name === "contracts" || name === "vercel") {
    const lanes = JSON.parse(
      readFileSync(join(root, "scripts/ci/contracts.json"), "utf8"),
    )
    // Real Vercel sandboxes need the deploy credentials, so that lane runs in
    // its own job; the other suites never select it.
    const hosted = new Set(lanes["hosted sandbox (Vercel)"] ?? [])
    const contracts = new Set(Object.values(lanes).flat())
    for (const [lane, required] of Object.entries(lanes)) {
      if (
        !listOnly &&
        name === "contracts" &&
        !required.some((file) => hosted.has(file))
      )
        process.stdout.write(`CONTRACT ${lane}: ${required.join(", ")}\n`)
      for (const file of required)
        if (!files.includes(file))
          throw new Error(`Missing required ${lane} contract: ${file}`)
    }
    // CI runs both lanes. Keep the full discovered inventory, but execute each
    // file once; the contract lane retains its stricter zero-failure baseline.
    selection = files.filter((file) =>
      name === "vercel"
        ? hosted.has(file)
        : !hosted.has(file) && contracts.has(file) === (name === "contracts"),
    )
    files = selection
  }
  if (!files.length) throw new Error(`No required tests selected for ${name}`)
  if (listOnly) {
    process.stdout.write(`${JSON.stringify(files.sort(), null, 2)}\n`)
  } else {
    if (name === "backend" || name === "contracts")
      run("scripts/ci/prerequisites.mjs")
    run("scripts/ci/check-allowlist-history.mjs", [baseline])
    const output = resolve(
      root,
      process.env.CI_TEST_RESULTS_DIR ?? ".ci-results",
      name,
    )
    mkdirSync(output, { recursive: true })
    const inventory = join(output, "inventory.json")
    const report = join(output, "results.json")
    rmSync(report, { force: true })
    writeFileSync(inventory, JSON.stringify(files, null, 2) + "\n")
    const require = createRequire(join(cwd, "package.json"))
    if (name === "cli") {
      const built = spawnSync(
        process.execPath,
        [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"],
        { cwd, stdio: "inherit" },
      )
      if (built.status !== 0) throw new Error("Required CLI build failed")
    }
    if (name === "aws-cdk") {
      run("packages/aws-cdk/scripts/stamp-image-tag.mjs")
      run("packages/aws-cdk/scripts/embed-chat-sandbox.mjs")
    }
    const vitest = join(
      dirname(require.resolve("vitest/package.json")),
      "vitest.mjs",
    )
    const result = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        ...selection,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      {
        cwd,
        stdio: "inherit",
        // Native contracts include real lease expiry and resource cleanup deadlines.
        // Each file runs in exactly one lane. Ownership contracts add real lease
        // expiry, writer-loss recovery, and the Btrfs quota runner; 30 minutes
        // killed the contract suite after the quota assertion and before Failed
        // Tests. Only that lane needs the extra ceiling.
        timeout:
          name === "backend"
            ? 1_800_000
            : name === "contracts"
              ? 2_700_000
              : 600_000,
      },
    )
    if (result.error || result.signal)
      throw new Error(
        `Test runner did not finish: ${result.error?.message ?? result.signal}`,
      )
    run(
      "scripts/ci/check-test-report.mjs",
      [report, join(root, baseline), String(result.status), inventory],
      cwd,
    )
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
