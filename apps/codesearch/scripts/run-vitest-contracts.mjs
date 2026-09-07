import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const root = fileURLToPath(new URL("../../../", import.meta.url))
const require = createRequire(join(cwd, "package.json"))
try {
  for (const binary of ["node", "bun", "git"]) {
    process.stdout.write(
      `${binary}: ${execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()}\n`,
    )
  }
  const files = readdirSync(join(cwd, "src"), { recursive: true })
    .filter((file) => typeof file === "string" && file.endsWith(".test.ts"))
    .map((file) => `src/${file}`)
  const bun = [
    "src/domain/repositories/globFiles.test.ts",
    "src/routes/repo.test.ts",
  ]
  for (const file of bun)
    if (!files.includes(file)) throw new Error(`Missing Bun contract: ${file}`)
  const vitest = join(
    dirname(require.resolve("vitest/package.json")),
    "vitest.mjs",
  )
  const directory = join(root, ".ci-results", "codesearch")
  mkdirSync(directory, { recursive: true })
  const baseline = join(directory, "no-allowed-failures.json")
  writeFileSync(baseline, JSON.stringify({ version: 1, failures: [] }))
  let failed = false
  for (const runtime of ["node", "bun"]) {
    const selected =
      runtime === "bun" ? bun : files.filter((file) => !bun.includes(file))
    const report = join(directory, `${runtime}.json`)
    const inventory = join(directory, `${runtime}-inventory.json`)
    writeFileSync(inventory, JSON.stringify(selected, null, 2))
    rmSync(report, { force: true })
    const result = spawnSync(
      runtime,
      [
        vitest,
        "run",
        ...selected,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      {
        cwd,
        stdio: "inherit",
        timeout: 600_000,
      },
    )
    if (result.error || result.signal)
      throw new Error(
        `Codesearch ${runtime} did not finish: ${result.error?.message ?? result.signal}`,
      )
    const checked = spawnSync(
      "node",
      [
        join(root, "scripts/ci/check-test-report.mjs"),
        report,
        baseline,
        String(result.status),
        inventory,
      ],
      {
        cwd,
        stdio: "inherit",
      },
    )
    if (checked.status !== 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
