// Fails when a secret can reach code that the team did not write or review:
// a dependency install script, a package, a build step, branch code. A job is
// the trust boundary: each job has its own runner, but a step that runs such
// code can change every later step of its job (it can write BASH_ENV or PATH
// to $GITHUB_ENV, change files, leave a process that reads the environment of
// a later step) and can read the memory of the runner. Thus:
// - No workflow puts a secret in its top-level `env:`, and no job puts one in
//   its job `env:`: a secret goes only to the steps that need it.
// - A job that holds a secret (any `secrets.*` other than GITHUB_TOKEN) does
//   not run a package manager, a TypeScript runtime, `make`, `sh -c`, a git
//   fetch or checkout, or an image build. It uses no local action
//   (`uses: ./…`), checks out no other commit (`ref:`), and runs or sources
//   only the reviewed scripts below. It reads no `toJSON(secrets)` and no
//   `secrets[…]`.
// - NEON_API_KEY and RAILWAY_API_TOKEN never go to a job that runs
//   untrusted code. No exception covers them.
// - GitHub environments: `Preview` is only for the jobs that deploy, roll or
//   delete the Railway PR preview. `workbench` is for checks, evals, proofs and
//   live contracts that call outside services, with spend-capped or test-scoped
//   keys.
//   `Production` is the production deploy.
//   A job that runs untrusted code and reads MODEL_PROVIDER_API_KEY
//   or VERCEL_ACCESS_TOKEN uses
//   `environment: workbench`. To add a paid or outside check, put the job in
//   `workbench`: this guard enforces it.
// - RAILWAY_API_TOKEN and NEON_API_KEY never go to a job in `workbench`.
// - A sticky disk or an actions/cache key that a job with a secret mounts or
//   restores is not written by a job that runs untrusted code. The check
//   reads each `${{ … }}` part of a key as "any text", and a `restore-keys`
//   entry as a prefix. This rule also reads deploy.yaml. (setup-node `cache:`
//   entries are GitHub caches, scoped to the branch of the run: a PR run
//   cannot write to the scope of main.)
// Untrusted code: a package manager, npm (use a pinned release binary with a
// checked sha256), pip, `go install` and `go run`, a third-party apt
// repository or package, `terraform init` without `-lockfile=readonly` (that
// flag checks each provider against the hashes in .terraform.lock.hcl), an
// image build (also `docker compose … --build`), `make`, `sh -c`, and a git
// fetch or checkout.
// - A job that holds a secret uses a third-party action (not `actions/…`)
//   only when it is pinned by a 40-character commit SHA: a tag can move to
//   other code. Put the version in a comment after the SHA.
// The production jobs in productionJobs run only on a push to main, so the
// rules for one job do not apply to them; the pin rule and the cache rule do.
// Every other job of deploy.yaml gets all the rules.
// The check reads each workflow line by line. It ignores comment lines.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const production = join(".github", "workflows", "deploy.yaml")

// Production deploy jobs that run untrusted code with production secrets, by
// a decision of the team. Each one runs only on a push to main (the check
// keeps its `if:` so), with merged code and a frozen lockfile, and the
// production runtime trusts the same dependencies.
const productionJobs = new Map(
  Object.entries({
    // `pnpm install`: migrate (tsx src/db/migrate.ts) and the cleanup of
    // preview sandboxes (Vercel SDK) need the dependencies. The production
    // Terraform variables, the Railway and Neon keys and the production
    // database URL are in this job.
    "deploy.yaml:terraform": "migrate and the sandbox cleanup need packages",
    // `pnpm install`: the Forge CLI deploys the Forge app with the Forge
    // token.
    "deploy.yaml:forge_deploy": "the Forge CLI is a package",
  }),
)

// The one job that runs untrusted code with an outside-service secret and
// stays in `Preview`: it deletes the sandboxes of the Railway PR preview (the
// preview Vercel project), not the sandboxes that CI contracts make.
const previewCheckJobs = new Set(["pr-deploy.yaml:cleanup_pr_sandboxes"])

// Secrets that need `environment: workbench` in a job with untrusted code.
const checkSecrets =
  /(?<![\w./-])secrets\s*\.\s*(MODEL_PROVIDER_API_KEY|VERCEL_ACCESS_TOKEN)\b/

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
    // The job uses the workbench environment: its model key is the
    // spend-capped CI key, not the production key.
    "mcp-evals.yaml:evals": ["MODEL_PROVIDER_API_KEY"],
    // Ingests real repositories with a real model and the preview GitHub App.
    // INGEST_PROOF_* hold the private test repository URLs, no credential:
    // a secret keeps them out of the public log.
    "ingestion-v2-proof.yaml:proof": [
      "MODEL_PROVIDER_API_KEY",
      "GH_APP_ID",
      "GH_PRIVATE_KEY",
      "INGEST_PROOF_REPOS",
      "INGEST_PROOF_WORKSPACE_REPO",
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
const accountTokens =
  /(?<![\w.-])secrets\s*\.\s*(NEON_API_KEY|RAILWAY_API_TOKEN|MODEL_PROVIDER_API_KEY)\b/
const untrusted = [
  [
    /\b(pnpm|yarn|bun|bunx|tsx|npx)\b/,
    "runs a package manager or a TypeScript runtime",
  ],
  [
    /\bnpm\s+\S/,
    "runs npm (install scripts and floating dependencies). Download a pinned release binary and check its sha256",
  ],
  [/\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\b|\bpipx\b/, "runs pip"],
  [/\bgo\s+(install|run|get|generate)\b/, "runs `go install` or `go run`"],
  [
    /\badd-apt-repository\b|sources\.list|\bdpkg\s+-i\b|\bapt(-get)?\s+install\b.*\.deb\b/,
    "installs from a third-party apt repository or package",
  ],
  [
    /\bterraform\s+init\b(?!.*-lockfile=readonly)/,
    "runs `terraform init` without -lockfile=readonly, so providers are not checked against .terraform.lock.hcl",
  ],
  [/\bgit\s+(checkout|switch|worktree|fetch|pull)\b/, "gets other git commits"],
  [
    /build-push-action|\bdocker\s+(build|buildx)\b|\bdocker[\s-]compose\b.*\s--build\b/,
    "builds an image",
  ],
  [/(^|[;&|(]|\brun:)\s*make\b/, "runs make"],
  [/\bsh\s+-c\b/, "runs `sh -c`"],
]
// A third-party action pinned by a full commit SHA.
const pinnedAction = /@[0-9a-f]{40}$/
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
      jobs.push({ name: header[1], lines: [], env: [], steps: [] })
      continue
    }
    const job = jobs.at(-1)
    if (!job) continue
    job.lines.push(line)
    // The job `env:` block: `env:` at the job level, then deeper lines.
    if (/^ {4}\S/.test(line.text)) job.inEnv = /^ {4}env:\s*$/.test(line.text)
    else if (job.inEnv && line.text.trim() !== "") job.env.push(line)
    if (/^\s{4,6}-\s/.test(line.text))
      job.steps.push({ uses: "", keys: [], inRestoreKeys: false })
    const step = job.steps.at(-1)
    if (!step) continue
    const uses = /^\s+(?:-\s+)?uses:\s*(\S+)/.exec(line.text)
    if (uses) step.uses = uses[1]
    const key = /^\s+(key|restore-keys):\s*(.*?)\s*$/.exec(line.text)
    if (key) {
      step.inRestoreKeys = key[1] === "restore-keys"
      if (key[2] && key[2] !== "|")
        step.keys.push({
          key: key[2],
          prefix: step.inRestoreKeys,
          number: line.number,
        })
      continue
    }
    if (step.inRestoreKeys && /^\s{10,}\S/.test(line.text))
      step.keys.push({
        key: line.text.trim(),
        prefix: true,
        number: line.number,
      })
    else step.inRestoreKeys = false
  }
  return { workflowEnv, jobs }
}

// What a cache step does with its key: a sticky disk and actions/cache read
// and write, actions/cache/restore reads, actions/cache/save writes.
function cacheAccess(uses) {
  if (/^(useblacksmith\/stickydisk|actions\/cache)@/.test(uses))
    return { read: true, write: true }
  if (/^actions\/cache\/restore@/.test(uses))
    return { read: true, write: false }
  if (/^actions\/cache\/save@/.test(uses)) return { read: false, write: true }
  return undefined
}

// A key as a pattern: each `${{ … }}` part is any text, and a restore-keys
// entry is a prefix. Two keys overlap when the pattern of one matches the
// other with its `${{ … }}` parts removed.
function keyPattern({ key, prefix }) {
  const parts = key.split(/\$\{\{.*?\}\}/)
  const escaped = parts.map((part) =>
    part.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"),
  )
  return new RegExp(`^${escaped.join(".*")}${prefix ? "" : "$"}`)
}
const keyText = ({ key }) => key.replace(/\$\{\{.*?\}\}/g, "")
const keysOverlap = (a, b) =>
  keyPattern(a).test(keyText(b)) || keyPattern(b).test(keyText(a))

const failures = []
// Each cache key that a job with a secret reads, and each that a job with
// untrusted code writes.
const secretReads = []
const untrustedWrites = []
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
    const environment = job.lines
      .map(({ text }) => /^ {4}environment:\s*['"]?([\w-]+)/.exec(text)?.[1])
      .find(Boolean)
    const runsUntrusted = job.lines.some(({ text }) =>
      untrusted.some(([pattern]) => pattern.test(text)),
    )

    for (const step of job.steps) {
      const access = cacheAccess(step.uses)
      if (!access) continue
      for (const key of step.keys) {
        const use = { ...key, where: `${file}:${key.number} (job ${job.name})` }
        if (access.read && holdsSecret && (isProduction || !runsUntrusted))
          secretReads.push(use)
        if (access.write && runsUntrusted && !isProduction)
          untrustedWrites.push(use)
      }
    }

    if (holdsSecret)
      for (const { text, number } of job.lines) {
        const action = /^\s+(?:-\s+)?uses:\s*['"]?([^\s'"#]+)/.exec(text)?.[1]
        if (
          action &&
          !action.startsWith("actions/") &&
          !action.startsWith("./") &&
          !pinnedAction.test(action)
        )
          failures.push(
            `${file}:${number}: job ${job.name} holds a secret and uses ${action}, a third-party action that is not pinned. Pin it by its 40-character commit SHA, with the version in a comment.`,
          )
      }

    // HANDOFF_KEY is the cache key of the owner URL handoff. The log shows a
    // step `env:` or `with:` value before any mask exists, so a job masks the
    // key (from the job env, which the log hides) before a step shows it, and
    // never echoes it.
    const masked = job.lines.find(({ text }) =>
      /add-mask::.*\bHANDOFF_KEY\b/.test(text),
    )
    for (const { text, number } of job.lines) {
      if (/add-mask::/.test(text) || /GITHUB_(ENV|OUTPUT)/.test(text)) continue
      const shown =
        /\$\{\{[^}]*\bHANDOFF_KEY\b[^}]*\}\}/.test(text) ||
        /^\s*HANDOFF_KEY:/.test(text)
      const echoed = /\b(echo|printf)\b.*\bHANDOFF_KEY\b/.test(text)
      if ((shown && (!masked || number < masked.number)) || echoed)
        failures.push(
          `${file}:${number}: job ${job.name} can show HANDOFF_KEY in the log. Mask it with ::add-mask:: in an earlier step, and do not echo it.`,
        )
    }

    const productionJob = productionJobs.has(`${name}:${job.name}`)
    if (productionJob) {
      if (
        !job.lines.some(({ text }) =>
          /^ {4}if:.*github\.event_name != 'workflow_dispatch'/.test(text),
        )
      )
        failures.push(
          `${file}: job ${job.name} is a production job, but its if: does not limit it to the push to main.`,
        )
      continue
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
    if (!holdsSecret) continue
    const where = (number) =>
      `${file}:${number}: job ${job.name} holds a secret and`
    for (const { text, number } of job.env)
      if (secretUse.test(text))
        failures.push(
          `${where(number)} puts a secret in the job env, so every step gets it. Put it in the env of each step that needs it.`,
        )
    for (const { text, number } of job.lines) {
      if (dynamicSecrets.test(text))
        failures.push(
          `${where(number)} reads every secret (toJSON(secrets) or secrets[…]). Name each secret it needs.`,
        )
      const token = accountTokens.exec(text)
      if (runsUntrusted && token && token[1] !== "MODEL_PROVIDER_API_KEY")
        failures.push(
          `${where(number)} gives ${token[1]} to a job that runs untrusted code. Move it to a job without such code.`,
        )
      const accountSecret = /secrets\s*\.\s*(NEON_API_KEY|RAILWAY_API_TOKEN)\b/.exec(
        text,
      )
      if (accountSecret && /^workbench$/i.test(environment ?? ""))
        failures.push(
          `${where(number)} gives ${accountSecret[1]} to a job in the workbench environment. Only Preview and production jobs may read it.`,
        )
      const check = checkSecrets.exec(text)
      if (
        runsUntrusted &&
        check &&
        !/^workbench$/i.test(environment ?? "") &&
        !(
          previewCheckJobs.has(`${name}:${job.name}`) &&
          /^preview$/i.test(environment ?? "")
        )
      )
        failures.push(
          `${where(number)} gives ${check[1]} to a job that runs untrusted code, and the job does not use \`environment: workbench\` (spend-capped or test-scoped values). Use it, or move the secret to a job without such code.`,
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

for (const read of secretReads)
  for (const write of untrustedWrites)
    if (keysOverlap(read, write))
      failures.push(
        `The cache key ${read.key} is read by a job with a secret (${read.where}), and a job that runs untrusted code writes ${write.key} (${write.where}). Give each its own key.`,
      )

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
