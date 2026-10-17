// Fails when a job that holds the Railway account token
// (secrets.RAILWAY_API_TOKEN) can run branch code. A job is the trust
// boundary: each job has its own runner, but a step that runs branch code can
// change every later step of its job (it can write BASH_ENV or PATH to
// $GITHUB_ENV, change files, or leave a process that reads the environment of
// a later step). Thus a job with the token must not:
// - check out a commit other than the commit of the workflow file (a `ref:`
//   other than github.sha or github.workflow_sha, or a git checkout in a
//   script), because its scripts would then come from the PR head;
// - install dependencies or run a package manager (an install script of a
//   dependency is branch code), except `npm install -g` of a pinned package;
// - build an image from the checkout.
// The check reads each workflow line by line. It ignores comment lines.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

// The production deploy runs only for a push to main, so its code is the
// reviewed main branch, not a PR head.
const exempt = new Set([join(".github", "workflows", "deploy.yaml")])

const token = /\bsecrets\.RAILWAY_API_TOKEN\b/
const allowedRef = /^\$\{\{\s*github\.(sha|workflow_sha)\s*\}\}$/
const rules = [
  [
    /\b(pnpm|yarn|bun|bunx|tsx|npx)\b/,
    "runs a package manager or a TypeScript runtime",
  ],
  [
    /\bnpm\s+(?!install\s+-g\s+@?[\w./-]+@\d[\w.-]*\s*$)\S/,
    "runs npm other than `npm install -g <package>@<version>`",
  ],
  [/\bgit\s+(checkout|switch|worktree|fetch|pull)\b/, "gets other git commits"],
  [/build-push-action|\bdocker\s+(build|buildx)\b/, "builds an image"],
]

const failures = []
const workflowDir = join(root, ".github", "workflows")
for (const name of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
  const file = join(".github", "workflows", name)
  if (exempt.has(file)) continue
  const lines = readFileSync(join(root, file), "utf8").split("\n")
  const jobs = []
  let inJobs = false
  lines.forEach((line, index) => {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      return
    }
    if (/^\S/.test(line)) {
      inJobs = false
      return
    }
    if (!inJobs) return
    const header = /^ {2}([\w-]+):\s*$/.exec(line)
    if (header) {
      jobs.push({ name: header[1], lines: [] })
      return
    }
    jobs.at(-1)?.lines.push({ text: line, number: index + 1 })
  })

  for (const job of jobs) {
    const code = job.lines.filter(({ text }) => !text.trim().startsWith("#"))
    if (!code.some(({ text }) => token.test(text))) continue
    for (const { text, number } of code) {
      const where = `${file}:${number}: job ${job.name} holds RAILWAY_API_TOKEN and`
      const ref = /^\s+ref:\s*(.*?)\s*$/.exec(text)
      if (ref && !allowedRef.test(ref[1])) {
        failures.push(
          `${where} checks out ${ref[1]}. Check out the workflow commit (no ref:), and move branch code to a job without the token.`,
        )
      }
      for (const [pattern, what] of rules) {
        if (pattern.test(text)) {
          failures.push(
            `${where} ${what}. Branch code can change every later step of its job: move it to a job without the token.`,
          )
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
