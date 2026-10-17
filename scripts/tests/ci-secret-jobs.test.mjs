import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const scripts = fileURLToPath(new URL("..", import.meta.url))
const script = join(scripts, "ci", "check-secret-jobs.mjs")

// Runs the check on a copy of scripts/ with only the given files: each key is
// a path from the repository root.
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-secret-jobs-"))
  cpSync(scripts, join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  for (const [path, text] of Object.entries(files))
    writeFileSync(join(root, path), text)
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "ci", "check-secret-jobs.mjs")],
    { encoding: "utf8" },
  )
}

const workflow = (jobs) => ({
  ".github/workflows/w.yaml": `on: pull_request\njobs:\n${jobs}`,
})

function rejects(files, message) {
  const result = check(files)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, message)
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
const deployJob = (steps) => `  deploy:\n    steps:\n${steps}`

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
    rejects(
      workflow(deployJob(steps)),
      /w\.yaml:\d+: job deploy holds a secret/,
    )
  })
}

test("rejects a secret in the workflow env", () => {
  rejects(
    {
      ".github/workflows/w.yaml": `on: pull_request\nenv:\n  RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\njobs:\n  build:\n    steps:\n${install}`,
    },
    /w\.yaml:3: a secret in the workflow env/,
  )
})

test("rejects a local action in a job with a secret", () => {
  rejects(
    workflow(
      deployJob(`      - uses: ./.github/actions/setup-buildx\n${tokenStep}`),
    ),
    /uses a local action/,
  )
})

test("rejects a repository script that is not reviewed", () => {
  rejects(
    workflow(deployJob(`${tokenStep}      - run: bash scripts/build.sh\n`)),
    /runs scripts\/build\.sh, which is not a reviewed script/,
  )
  rejects(
    workflow(deployJob(`${tokenStep}      - run: node scripts/ci/x.mjs\n`)),
    /runs scripts\/ci\/x\.mjs, which is not a reviewed script/,
  )
})

test("rejects a reviewed script that runs a package manager", () => {
  rejects(
    {
      ...workflow(deployJob(tokenStep)),
      "scripts/railway-graphql.sh": "pnpm exec tsx x.ts\n",
    },
    /scripts\/railway-graphql\.sh:1: a reviewed script runs a package manager/,
  )
})

test("rejects make and sh -c in a job with a secret", () => {
  rejects(workflow(deployJob(`${tokenStep}      - run: make deploy\n`)), /runs make/)
  rejects(
    workflow(deployJob(`${tokenStep}      - run: sh -c "$CMD"\n`)),
    /runs `sh -c`/,
  )
})

test("rejects any ref: in a job with a secret", () => {
  rejects(
    workflow(
      deployJob(
        `      - uses: useblacksmith/checkout@v1\n        with:\n          ref: \${{ github.sha }}\n${tokenStep}`,
      ),
    ),
    /checks out \$\{\{ github\.sha \}\}/,
  )
})

test("rejects toJSON(secrets) and secrets[…]", () => {
  for (const value of ["${{ toJSON(secrets) }}", "${{ secrets[inputs.name] }}"])
    rejects(
      workflow(
        deployJob(`      - env:\n          ALL: ${value}\n        run: echo ok\n`),
      ),
      /reads every secret/,
    )
})

test("rejects any secret in a job that installs dependencies", () => {
  rejects(
    workflow(
      `  test:\n    env:\n      VERCEL_TOKEN: \${{ secrets.VERCEL_ACCESS_TOKEN }}\n    steps:\n      - uses: actions/checkout@v6\n${install}`,
    ),
    /job test holds a secret and runs a package manager/,
  )
})

test("accepts GITHUB_TOKEN in a job that installs dependencies", () => {
  const result = check(
    workflow(
      `  test:\n    steps:\n      - env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n        run: gh pr view\n${install}`,
    ),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("rejects NEON_API_KEY in a package manager job, even in a reviewed exception", () => {
  rejects(
    {
      ".github/workflows/mcp-evals.yaml": `on: pull_request\njobs:\n  evals:\n    steps:\n      - env:\n          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}\n        run: echo\n${install}`,
    },
    /gives NEON_API_KEY to a job that runs a package manager/,
  )
})

test("rejects a secret that a reviewed exception does not name", () => {
  rejects(
    {
      ".github/workflows/mcp-evals.yaml": `on: pull_request\njobs:\n  evals:\n    steps:\n      - env:\n          OTHER: \${{ secrets.OTHER_KEY }}\n        run: echo\n${install}`,
    },
    /is a reviewed exception for .* only, not OTHER_KEY/,
  )
})

const sticky = (key) =>
  `      - uses: useblacksmith/stickydisk@v1\n        with:\n          key: ${key}\n          path: ~/.pnpm-store\n`

test("rejects a sticky disk that a production job and a PR job share", () => {
  rejects(
    {
      ".github/workflows/deploy.yaml": `on: push\njobs:\n  terraform:\n    env:\n      TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\n    steps:\n${sticky("store")}${install}`,
      ".github/workflows/w.yaml": `on: pull_request\njobs:\n  migrate:\n    steps:\n${sticky("store")}${install}`,
    },
    /cache key store is used by a job with a secret \(.*deploy\.yaml:9 \(job terraform\)\) and by a job that runs untrusted code \(.*w\.yaml:7 \(job migrate\)\)/,
  )
})

test("rejects an actions/cache restore in a secret job that a branch-code job writes", () => {
  rejects(
    workflow(
      `  build:\n    steps:\n      - uses: actions/cache@v4\n        with:\n          key: tools\n${install}  deploy:\n    steps:\n      - uses: actions/cache/restore@v4\n        with:\n          key: tools\n${tokenStep}`,
    ),
    /cache key tools is used by a job with a secret/,
  )
})

test("accepts a trusted job that hands a value to a branch-code job through the cache", () => {
  const result = check(
    workflow(`  prepare:
    steps:
      - uses: useblacksmith/checkout@v1
      - env:
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
        run: source "\${GITHUB_WORKSPACE}/scripts/preview-neon-branch.sh"
      - uses: actions/cache/save@v4
        with:
          key: handoff
  migrate:
    needs: [prepare]
    steps:
${headCheckout}      - uses: actions/cache/restore@v4
        with:
          key: handoff
${sticky("store-pr")}${install}`),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("accepts a token job on the workflow commit, apart from a branch-code job", () => {
  const result = check(
    workflow(`  migrate:
    steps:
${headCheckout}${install}      - run: pnpm exec tsx src/db/migrate.ts
  deploy:
    needs: [migrate]
    steps:
      # No ref: the workflow commit. pnpm install runs in migrate.
      - uses: useblacksmith/checkout@v1
      - run: npm install -g @railway/cli@4.35.2
${tokenStep}`),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("rejects a main-only job whose if: does not name main", () => {
  rejects(
    {
      ".github/workflows/observability.yaml": `on: push\njobs:\n  apply:\n    if: github.event_name == 'push'\n    env:\n      T: \${{ secrets.RAILWAY_TOKEN }}\n    steps:\n${install}`,
    },
    /job apply is a main-only job/,
  )
})

test("accepts the workflows of this repository", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})
