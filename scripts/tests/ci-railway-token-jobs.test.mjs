import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-railway-token-jobs.mjs", import.meta.url),
)

function check(workflow) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-railway-token-"))
  mkdirSync(join(root, "scripts", "ci"), { recursive: true })
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  cpSync(script, join(root, "scripts", "ci", "check-railway-token-jobs.mjs"))
  writeFileSync(join(root, ".github", "workflows", "w.yaml"), workflow)
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "ci", "check-railway-token-jobs.mjs")],
    { encoding: "utf8" },
  )
}

const tokenStep = `      - name: Railway
        env:
          RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}
        run: |
          source "\${GITHUB_WORKSPACE}/scripts/railway-graphql.sh"
`
const headCheckout = `      - uses: useblacksmith/checkout@v1
        with:
          ref: \${{ needs.resolve_pr.outputs.head_sha }}
`
const install = "      - run: pnpm install --frozen-lockfile\n"

for (const [name, steps] of [
  ["sources a script from the PR head checkout", headCheckout + tokenStep],
  [
    "runs after pnpm install",
    `      - uses: useblacksmith/checkout@v1\n${install}${tokenStep}`,
  ],
  [
    "runs before pnpm install in the same job",
    `      - uses: useblacksmith/checkout@v1\n${tokenStep}${install}`,
  ],
  [
    "runs after migrate",
    "      - uses: useblacksmith/checkout@v1\n      - run: tsx src/db/migrate.ts\n" +
      tokenStep,
  ],
  [
    "runs after a git checkout of the PR head",
    '      - uses: useblacksmith/checkout@v1\n      - run: git checkout "$HEAD_SHA"\n' +
      tokenStep,
  ],
]) {
  test(`rejects a token step that ${name}`, () => {
    const result = check(
      `on: pull_request\njobs:\n  deploy:\n    steps:\n${steps}`,
    )
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /w\.yaml:\d+: job deploy holds RAILWAY_API_TOKEN/,
    )
  })
}

test("rejects a job-level token in a job that installs dependencies", () => {
  const result = check(
    `jobs:\n  deploy:\n    env:\n      RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\n    steps:\n      - uses: useblacksmith/checkout@v1\n${install}`,
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /runs a package manager/)
})

test("accepts a token job on the workflow commit, apart from a branch-code job", () => {
  const result = check(`jobs:
  migrate:
    steps:
${headCheckout}${install}      - run: pnpm exec tsx src/db/migrate.ts
  deploy:
    needs: [migrate]
    steps:
      # No ref: the workflow commit. pnpm install runs in migrate.
      - uses: useblacksmith/checkout@v1
      - run: npm install -g @railway/cli@4.35.2
${tokenStep}`)
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("accepts the workflows of this repository", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})
