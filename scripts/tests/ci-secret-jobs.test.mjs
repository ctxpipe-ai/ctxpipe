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
  rejects(
    workflow(deployJob(`${tokenStep}      - run: make deploy\n`)),
    /runs make/,
  )
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
        deployJob(
          `      - env:\n          ALL: ${value}\n        run: echo ok\n`,
        ),
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
    /gives NEON_API_KEY to a job that runs untrusted code/,
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
const pinnedSticky = (key) =>
  `      - uses: useblacksmith/stickydisk@3f6be1451e3cad893b778bc93495c80452a5da26 # v1\n        with:\n          key: ${key}\n          path: ~/.pnpm-store\n`

test("rejects a sticky disk that a production job and a PR job share", () => {
  rejects(
    {
      ".github/workflows/deploy.yaml": `on: push\njobs:\n  terraform:\n    env:\n      TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\n    steps:\n${sticky("store")}${install}`,
      ".github/workflows/w.yaml": `on: pull_request\njobs:\n  migrate:\n    steps:\n${sticky("store")}${install}`,
    },
    /cache key store is read by a job with a secret \(.*deploy\.yaml:9 \(job terraform\)\), and a job that runs untrusted code writes store \(.*w\.yaml:7 \(job migrate\)\)/,
  )
})

test("rejects an actions/cache restore in a secret job that a branch-code job writes", () => {
  rejects(
    workflow(
      `  build:\n    steps:\n      - uses: actions/cache@v4\n        with:\n          key: tools\n${install}  deploy:\n    steps:\n      - uses: actions/cache/restore@v4\n        with:\n          key: tools\n${tokenStep}`,
    ),
    /cache key tools is read by a job with a secret/,
  )
})

test("accepts a trusted job that hands a value to a branch-code job through the cache", () => {
  const result = check(
    workflow(`  prepare:
    steps:
      - uses: actions/checkout@v6
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
      - uses: actions/checkout@v6
      - run: |
          curl -fsSL -o railway.tar.gz "$URL"
          echo "$SHA256  railway.tar.gz" | sha256sum --check --strict
          tar -xzf railway.tar.gz railway
${tokenStep}`),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

for (const [name, command, message] of [
  ["npm install -g", "npm install -g @railway/cli@4.35.2", /runs npm/],
  ["npm i", "npm i left-pad", /runs npm/],
  ["npm ci", "npm ci", /runs npm/],
  ["docker build", "docker build -t x .", /builds an image/],
  ["docker compose --build", "docker compose up -d --build", /builds an image/],
  ["docker-compose --build", "docker-compose up --build", /builds an image/],
  ["pip install", "pip install requests", /runs pip/],
  ["python -m pip", "python3 -m pip install requests", /runs pip/],
  ["go install", "go install example.com/tool@v1", /runs `go install`/],
  ["go run", "go run ./cmd/x", /runs `go install`/],
  [
    "add-apt-repository",
    "sudo add-apt-repository ppa:x/y && sudo apt-get install -y y",
    /third-party apt repository/,
  ],
  [
    "a third-party apt source",
    "echo deb https://x.example/apt stable main | sudo tee /etc/apt/sources.list.d/x.list",
    /third-party apt repository/,
  ],
  ["dpkg -i", "sudo dpkg -i x.deb", /third-party apt repository/],
  [
    "terraform init without -lockfile=readonly",
    "terraform init -input=false",
    /terraform init` without -lockfile=readonly/,
  ],
]) {
  test(`rejects ${name} in a job with a secret`, () => {
    rejects(
      workflow(deployJob(`${tokenStep}      - run: ${command}\n`)),
      message,
    )
  })
}

test("accepts apt-get install from the runner image sources and terraform init -lockfile=readonly", () => {
  const result = check(
    workflow(
      deployJob(
        `${tokenStep}      - run: sudo apt-get install -y -qq postgresql-client\n      - run: terraform init -input=false -lockfile=readonly\n`,
      ),
    ),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("rejects a secret in the job env", () => {
  rejects(
    workflow(
      `  deploy:\n    env:\n      PR_ENV: pr-1\n      RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\n    steps:\n      - run: echo\n`,
    ),
    /w\.yaml:6: job deploy holds a secret and puts a secret in the job env/,
  )
})

test("accepts a job env without secrets and a secret in a step env", () => {
  const result = check(
    workflow(
      `  deploy:\n    env:\n      PR_ENV: pr-1\n    steps:\n${tokenStep}`,
    ),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("rejects an account token in a job that runs any untrusted code, even in a reviewed exception", () => {
  for (const command of [
    "docker compose up -d --build",
    "npm install -g x@1.0.0",
    "go run ./cmd/x",
  ])
    rejects(
      {
        ".github/workflows/ingestion-v2-proof.yaml": `on: push\njobs:\n  proof:\n    steps:\n      - env:\n          RAILWAY_API_TOKEN: \${{ secrets.RAILWAY_API_TOKEN }}\n        run: ${command}\n`,
      },
      /gives RAILWAY_API_TOKEN to a job that runs untrusted code/,
    )
})

const secretJob = (secret, environment, file = "mcp-evals.yaml", job = "evals") => ({
  [`.github/workflows/${file}`]: `on: pull_request\njobs:\n  ${job}:\n${environment}    steps:\n${install}      - env:\n          ${secret}: \${{ secrets.${secret} }}\n        run: bun evals/run.ts\n`,
})

test("rejects an outside-service secret in a job with untrusted code outside workbench", () => {
  for (const secret of [
    "MODEL_PROVIDER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "VERCEL_ACCESS_TOKEN",
  ]) {
    for (const environment of [
      "",
      "    environment: Production\n",
      "    environment: Preview\n",
    ])
      rejects(
        secretJob(secret, environment),
        new RegExp(
          `gives ${secret} to a job that runs untrusted code, and the job does not use .environment: workbench`,
        ),
      )
    const result = check(secretJob(secret, "    environment: workbench\n"))
    assert.doesNotMatch(result.stderr, /environment: workbench/)
  }
})

test("keeps the preview sandbox cleanup in Preview", () => {
  const cleanup = (environment) =>
    secretJob(
      "VERCEL_ACCESS_TOKEN",
      environment,
      "pr-deploy.yaml",
      "cleanup_pr_sandboxes",
    )
  const result = check(cleanup("    environment: Preview\n"))
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
  rejects(cleanup(""), /does not use .environment: workbench/)
})

test("rejects the Railway and Neon keys in the workbench environment", () => {
  for (const secret of ["RAILWAY_API_TOKEN", "NEON_API_KEY"])
    rejects(
      {
        ".github/workflows/w.yaml": `on: pull_request\njobs:\n  check:\n    environment: workbench\n    steps:\n      - env:\n          ${secret}: \${{ secrets.${secret} }}\n        run: echo ok\n`,
      },
      new RegExp(`gives ${secret} to a job in the workbench environment`),
    )
})

const cacheStep = (action, key, extra = "") =>
  `      - uses: actions/cache${action}@v4\n        with:\n          path: x\n          key: ${key}\n${extra}`

test("rejects actions/cache/save in a branch-code job that a secret job restores", () => {
  rejects(
    workflow(
      `  build:\n    steps:\n${cacheStep("/save", "tools")}${install}  deploy:\n    steps:\n${cacheStep("/restore", "tools")}${tokenStep}`,
    ),
    /cache key tools is read by a job with a secret .* and a job that runs untrusted code writes tools/,
  )
})

test("rejects a cache key that matches once its expressions are removed", () => {
  rejects(
    workflow(
      `  build:\n    steps:\n${cacheStep("/save", "tools-evil")}${install}  deploy:\n    steps:\n${cacheStep("/restore", `tools-\${{ hashFiles('x') }}`)}${tokenStep}`,
    ),
    /cache key tools-\$\{\{ hashFiles\('x'\) \}\} is read by a job with a secret/,
  )
})

test("rejects a restore-keys prefix that a branch-code job writes", () => {
  rejects(
    workflow(
      `  build:\n    steps:\n${cacheStep("", "tools-linux-1")}${install}  deploy:\n    steps:\n${cacheStep("/restore", `tools-\${{ github.sha }}`, "          restore-keys: |\n            tools-\n")}${tokenStep}`,
    ),
    /cache key tools- is read by a job with a secret/,
  )
})

test("accepts a production sticky disk and a PR sticky disk with a longer key", () => {
  const result = check({
    ".github/workflows/deploy.yaml": `on: push\njobs:\n  terraform:\n    if: github.event_name != 'workflow_dispatch'\n    steps:\n${pinnedSticky(`\${{ github.repository }}-pnpm-store`)}      - env:\n          T: \${{ secrets.RAILWAY_API_TOKEN }}\n        run: echo\n`,
    ".github/workflows/w.yaml": `on: pull_request\njobs:\n  migrate:\n    steps:\n${sticky(`\${{ github.repository }}-pnpm-store-pr`)}${install}`,
  })
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

test("rejects a third-party action by tag in a job with a secret", () => {
  rejects(
    workflow(deployJob(`      - uses: nick-fields/retry@v4\n${tokenStep}`)),
    /job deploy holds a secret and uses nick-fields\/retry@v4, a third-party action that is not pinned/,
  )
  rejects(
    workflow(
      deployJob(
        `      - uses: nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60 # v4\n      - uses: "dataaxiom/ghcr-cleanup-action@v1"\n${tokenStep}`,
      ),
    ),
    /uses dataaxiom\/ghcr-cleanup-action@v1, a third-party action that is not pinned/,
  )
})

test("accepts a pinned third-party action and actions/* by tag in a job with a secret, and any tag without a secret", () => {
  const result = check(
    workflow(`  deploy:
    steps:
      - uses: actions/checkout@v6
      - uses: nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60 # v4
${tokenStep}  build:
    steps:
      - uses: useblacksmith/checkout@v1
`),
  )
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})

test("rejects an unpinned third-party action in a production job", () => {
  rejects(
    {
      ".github/workflows/deploy.yaml": `on: push\njobs:\n  terraform:\n    if: github.event_name != 'workflow_dispatch'\n    steps:\n      - uses: hashicorp/setup-terraform@v3\n      - env:\n          T: \${{ secrets.RAILWAY_API_TOKEN }}\n        run: echo\n`,
    },
    /deploy\.yaml:6: job terraform holds a secret and uses hashicorp\/setup-terraform@v3/,
  )
})

test("applies every rule to a deploy.yaml job that is not a named production job", () => {
  rejects(
    {
      ".github/workflows/deploy.yaml": `on: push\njobs:\n  release:\n    if: github.event_name != 'workflow_dispatch'\n    steps:\n${install}      - env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n        run: echo\n`,
    },
    /job release holds a secret and runs a package manager/,
  )
})

test("rejects a production job whose if: does not limit it to the push to main", () => {
  rejects(
    {
      ".github/workflows/deploy.yaml": `on: push\njobs:\n  terraform:\n    steps:\n${install}      - env:\n          T: \${{ secrets.RAILWAY_API_TOKEN }}\n        run: echo\n`,
    },
    /job terraform is a production job, but its if: does not limit it to the push to main/,
  )
})

test("accepts the workflows of this repository", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.stderr, "")
  assert.equal(result.status, 0)
})
