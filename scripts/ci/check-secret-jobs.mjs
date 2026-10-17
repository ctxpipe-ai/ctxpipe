// Fails when a secret can reach code that the team did not write or review:
// a dependency install script, a package, a build step, branch code. A job is
// the trust boundary: each job has its own runner, but a step that runs such
// code can change every later step of its job (it can write BASH_ENV or PATH
// to $GITHUB_ENV, change files, leave a process that reads the environment of
// a later step) and can read the memory of the runner. Thus:
// - No workflow puts a secret in its top-level `env:`.
// - A job that holds a secret (any `secrets.*` other than GITHUB_TOKEN) does
//   not run a package manager, a TypeScript runtime, `make`, `sh -c`, a git
//   fetch or checkout, or an image build. It uses no local action
//   (`uses: ./…`), checks out no other commit (`ref:`), and runs or sources
//   only the reviewed scripts below. It reads no `toJSON(secrets)` and no
//   `secrets[…]`.
// - NEON_API_KEY and RAILWAY_API_TOKEN never go to a job that runs a package
//   manager. No exception covers them.
// - A sticky disk or an actions/cache key that a job with a secret mounts or
//   restores is not used by a job that runs untrusted code. This rule also
//   reads deploy.yaml. (setup-node `cache:` entries are GitHub caches, scoped
//   to the branch of the run: a PR run cannot write to the scope of main.)
// The production deploy (deploy.yaml) runs only for main, so the rules for
// one job do not apply to it; the cache rule does.
// The check reads each workflow line by line. It ignores comment lines.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const production = join(".github", "workflows", "deploy.yaml")

// Scripts that a job with a secret may run or source. Each runs no package
// manager; the check reads each one to keep that true.
const reviewedScripts = new Set([
  "scripts/ci/smoke-preview-ui.sh",
  "scripts/preview-app-db-password.sh",
  "scripts/preview-github-app-vars.sh",
  "scripts/preview-neon-branch.sh",
  "scripts/preview-otel-vars.sh",
  "scripts/preview-own-secrets.sh",
  "scripts/preview-sandbox-vars.sh",
  "scripts/preview-ui-private.sh",
  "scripts/railway-graphql.sh",
])

// Jobs that run untrusted code with a secret, by design, until each one moves
// to a job without the secret. Each entry names the only secrets it may hold.
const exceptions = new Map(
  Object.entries({
    // Deletes preview Vercel sandboxes with the backend Vercel SDK.
    "pr-deploy.yaml:cleanup_pr_sandboxes": ["VERCEL_ACCESS_TOKEN"],
    // Tests the sandbox provider against the preview Vercel project.
    "ci.yaml:vercel-sandbox": ["VERCEL_ACCESS_TOKEN"],
    // Evaluates the product MCP with real models.
    "mcp-evals.yaml:evals": [
      "MODEL_PROVIDER_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ],
    // Ingests real repositories with a real model and the preview GitHub App.
    "ingestion-v2-proof.yaml:proof": [
      "MODEL_PROVIDER_API_KEY",
      "GH_APP_ID",
      "GH_PRIVATE_KEY",
    ],
  }),
)

// Jobs that run only for main, as deploy.yaml does. The check keeps their
// `if:` limited to refs/heads/main.
const mainOnly = new Set(["observability.yaml:apply"])

const secretUse =
  /(?<![\w./-])secrets\s*(\.\s*(?!GITHUB_TOKEN\b)\w+|\[)|toJSON\(\s*secrets\s*\)|^\s*secrets:\s*inherit\b/
const dynamicSecrets = /toJSON\(\s*secrets\s*\)|(?<![\w./-])secrets\s*\[/
const secretName = /(?<![\w./-])secrets\s*\.\s*(\w+)/g
const accountTokens = /\b(NEON_API_KEY|RAILWAY_API_TOKEN)\b/
const packageManager = /\b(pnpm|yarn|bun|bunx|tsx|npx)\b/
const untrusted = [
  [packageManager, "runs a package manager or a TypeScript runtime"],
  [
    /\bnpm\s+(?!install\s+-g\s+@?[\w./-]+@\d[\w.-]*\s*$)\S/,
    "runs npm other than `npm install -g <package>@<version>`",
  ],
  [/\bgit\s+(checkout|switch|worktree|fetch|pull)\b/, "gets other git commits"],
  [/build-push-action|\bdocker\s+(build|buildx)\b/, "builds an image"],
  [/(^|[;&|(]|\brun:)\s*make\b/, "runs make"],
  [/\bsh\s+-c\b/, "runs `sh -c`"],
]
const scriptPath = /(?:^|[\s"'=(/}])(?:\.\/)?(scripts\/[\w./-]+)/g

function code(text) {
  return text
    .split("\n")
    .map((line, index) => ({ text: line, number: index + 1 }))
    .filter(({ text }) => !text.trim().startsWith("#"))
}

function parse(text) {
  const workflowEnv = []
  const jobs = []
  let section = ""
  for (const line of code(text)) {
    if (/^\S/.test(line.text)) {
      section = /^(\w+):/.exec(line.text)?.[1] ?? ""
      continue
    }
    if (section === "env") workflowEnv.push(line)
    if (section !== "jobs") continue
    const header = /^ {2}([\w-]+):\s*$/.exec(line.text)
    if (header) {
      jobs.push({ name: header[1], lines: [], steps: [] })
      continue
    }
    const job = jobs.at(-1)
    if (!job) continue
    job.lines.push(line)
    if (/^\s{4,6}-\s/.test(line.text)) job.steps.push({ uses: "", keys: [] })
    const step = job.steps.at(-1)
    const uses = /^\s+(?:-\s+)?uses:\s*(\S+)/.exec(line.text)
    if (step && uses) step.uses = uses[1]
    const key = /^\s+key:\s*(.+?)\s*$/.exec(line.text)
    if (step && key) step.keys.push({ key: key[1], number: line.number })
  }
  return { workflowEnv, jobs }
}

const failures = []
const cacheUse = new Map()
const workflowDir = join(root, ".github", "workflows")

for (const script of reviewedScripts) {
  if (!existsSync(join(root, script))) {
    failures.push(`${script} is a reviewed script, but it does not exist.`)
    continue
  }
  for (const { text, number } of code(readFileSync(join(root, script), "utf8")))
    for (const [pattern, what] of untrusted)
      if (pattern.test(text))
        failures.push(
          `${script}:${number}: a reviewed script ${what}. A job with a secret sources it.`,
        )
}

for (const name of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
  const file = join(".github", "workflows", name)
  const { workflowEnv, jobs } = parse(readFileSync(join(root, file), "utf8"))
  const isProduction = file === production

  for (const { text, number } of workflowEnv)
    if (secretUse.test(text))
      failures.push(
        `${file}:${number}: a secret in the workflow env reaches every job. Put it in the env of the one step or job that needs it.`,
      )

  for (const job of jobs) {
    const holdsSecret = job.lines.some(({ text }) => secretUse.test(text))
    const runsUntrusted = job.lines.some(({ text }) =>
      untrusted.some(([pattern]) => pattern.test(text)),
    )
    const runsPackageManager = job.lines.some(({ text }) =>
      packageManager.test(text),
    )

    for (const step of job.steps) {
      if (
        !/^(useblacksmith\/stickydisk|actions\/cache)(\/restore)?@/.test(
          step.uses,
        )
      )
        continue
      for (const { key, number } of step.keys) {
        const use = cacheUse.get(key) ?? { secret: [], untrusted: [] }
        const where = `${file}:${number} (job ${job.name})`
        if (holdsSecret && (isProduction || !runsUntrusted))
          use.secret.push(where)
        if (runsUntrusted && !isProduction) use.untrusted.push(where)
        cacheUse.set(key, use)
      }
    }

    if (mainOnly.has(`${name}:${job.name}`)) {
      if (
        !job.lines.some(({ text }) =>
          /^ {4}if:.*github\.ref == 'refs\/heads\/main'/.test(text),
        )
      )
        failures.push(
          `${file}: job ${job.name} is a main-only job, but its if: does not limit it to refs/heads/main.`,
        )
      continue
    }
    if (isProduction || !holdsSecret) continue
    const where = (number) =>
      `${file}:${number}: job ${job.name} holds a secret and`
    for (const { text, number } of job.lines) {
      if (dynamicSecrets.test(text))
        failures.push(
          `${where(number)} reads every secret (toJSON(secrets) or secrets[…]). Name each secret it needs.`,
        )
      const token = accountTokens.exec(text)
      if (runsPackageManager && token)
        failures.push(
          `${where(number)} gives ${token[1]} to a job that runs a package manager. Move the account token to a job without branch code.`,
        )
    }

    const allowed = exceptions.get(`${name}:${job.name}`)
    if (allowed) {
      for (const { text, number } of job.lines)
        for (const [, secret] of text.matchAll(secretName))
          if (secret !== "GITHUB_TOKEN" && !allowed.includes(secret))
            failures.push(
              `${where(number)} is a reviewed exception for ${allowed.join(", ")} only, not ${secret}.`,
            )
      continue
    }

    for (const { text, number } of job.lines) {
      const ref = /^\s+ref:\s*(.*?)\s*$/.exec(text)
      if (ref)
        failures.push(
          `${where(number)} checks out ${ref[1]}. Check out the workflow commit (no ref:), and move branch code to a job without the secret.`,
        )
      if (/^\s+(?:-\s+)?uses:\s*\.\//.test(text))
        failures.push(
          `${where(number)} uses a local action. Its code comes from the checkout: move it to a job without the secret.`,
        )
      for (const [, script] of text.matchAll(scriptPath))
        if (!reviewedScripts.has(script))
          failures.push(
            `${where(number)} runs ${script}, which is not a reviewed script. Add it to reviewedScripts in scripts/ci/check-secret-jobs.mjs only if it runs no package manager.`,
          )
      for (const [pattern, what] of untrusted)
        if (pattern.test(text))
          failures.push(
            `${where(number)} ${what}. Untrusted code can read and change every later step of its job: move it to a job without the secret.`,
          )
    }
  }
}

for (const [key, use] of cacheUse)
  if (use.secret.length > 0 && use.untrusted.length > 0)
    failures.push(
      `The cache key ${key} is used by a job with a secret (${use.secret.join(", ")}) and by a job that runs untrusted code (${use.untrusted.join(", ")}). Give each its own key.`,
    )

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
