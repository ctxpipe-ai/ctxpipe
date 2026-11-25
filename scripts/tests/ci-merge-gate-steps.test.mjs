import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { parse as parseYaml } from "yaml"

// The steps of the Merge gate job that call the GitHub API. Each runs as the
// workflow runs it (the `run` text of the step in ci.yaml), with a `gh` on
// PATH that answers from files: the GitHub API is the environment, so it is
// the only fake.

const root = fileURLToPath(new URL("../../", import.meta.url))
const repo = "acme/widgets"

// `gh api <path> [--paginate|--silent] [--jq <expr>]` prints the file of that
// path (slashes become underscores), through jq when --jq is given, or fails
// with the text in `<name>.error`, or one time with the text in
// `<name>.error-once`. The fake `sleep` appends its argument to sleeps.log and
// does not wait.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_GH_DIR"
name="$(printf '%s' "$2" | tr '/' '_')"
if [ -f "$dir/$name.error-once" ]; then
  cat "$dir/$name.error-once" >&2
  rm "$dir/$name.error-once"
  exit 1
fi
if [ -f "$dir/$name.error" ]; then
  cat "$dir/$name.error" >&2
  exit 1
fi
expr=""
args=("\${@:3}")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[$i]}" = --jq ] && expr="\${args[$((i + 1))]}"
done
if [ -n "$expr" ]; then jq -r "$expr" "$dir/$name.json"; else cat "$dir/$name.json"; fi
`

const setup = ({
  api = {},
  errors = {},
  errorsOnce = {},
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-steps-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "gh"), fakeGh)
  chmodSync(join(bin, "gh"), 0o755)
  writeFileSync(
    join(bin, "sleep"),
    '#!/usr/bin/env bash\necho "$1" >> "$FAKE_GH_DIR/sleeps.log"\n',
  )
  chmodSync(join(bin, "sleep"), 0o755)
  const file = (path) => path.replaceAll("/", "_")
  for (const [path, body] of Object.entries(api))
    writeFileSync(join(dir, `${file(path)}.json`), JSON.stringify(body))
  for (const [path, text] of Object.entries(errors))
    writeFileSync(join(dir, `${file(path)}.error`), text)
  for (const [path, text] of Object.entries(errorsOnce))
    writeFileSync(join(dir, `${file(path)}.error-once`), text)
  return dir
}

// The shell of a step of ci.yaml, as the workflow holds it.
const stepShell = (job, stepName) => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  return workflow.jobs[job].steps.find(({ name }) => name === stepName).run
}

const run = (dir, env) => {
  const log = (name) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").trim().split("\n")
      : []
  const command = [
    "-c",
    `set -eo pipefail\n${stepShell("merge-gate", "The jobs of this run")}`,
  ]
  const result = spawnSync("bash", command, {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE_GH_DIR: dir,
      RUNNER_TEMP: dir,
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    sleeps: log("sleeps.log"),
  }
}

// The step that reads the jobs of this run attempt, with no earlier attempt.
const jobsPath = `repos/${repo}/actions/runs/9/attempts/1/jobs?per_page=100`
const readJobs = ({ api, ...options } = {}) => {
  const dir = setup({
    api: {
      [jobsPath]: { jobs: [{ id: 1, name: "Merge gate" }] },
      rate_limit: { resources: { core: { remaining: 0, reset: 0 } } },
      ...api,
    },
    ...options,
  })
  const result = run(dir, {
    REPO: repo,
    RUN: "9",
    ATTEMPT: "1",
  })
  const jobs = join(dir, "jobs.json")
  return {
    ...result,
    jobs: result.status === 0 ? JSON.parse(readFileSync(jobs, "utf8")) : null,
  }
}

test("gh_retry waits for the rate limit reset, and a limit that stays fails the call", () => {
  const limit = "API rate limit exceeded for installation ID 1 (HTTP 403)"
  const once = readJobs({ errorsOnce: { [jobsPath]: limit } })
  assert.equal(once.status, 0, once.stderr)
  assert.match(once.stderr, /the call runs again in 1s/)
  assert.deepEqual(once.sleeps, ["1"])
  assert.deepEqual(once.jobs, { jobs: [{ id: 1, name: "Merge gate" }] })
  // The step continues on error: the decision runs without the jobs.
  const stays = readJobs({ errors: { [jobsPath]: limit } })
  assert.notEqual(stays.status, 0)
  assert.match(stays.stderr, /API rate limit exceeded/)
  assert.deepEqual(stays.sleeps, ["1"])
  const broken = readJobs({
    errors: { [jobsPath]: "gh: Server Error (HTTP 500)" },
  })
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /HTTP 500/)
  assert.deepEqual(broken.sleeps, [])
})

test("gh_retry waits one minute for a secondary limit, does not wait for a far reset, and fails on another error after the wait", () => {
  const secondary = readJobs({
    api: { rate_limit: { resources: { core: { remaining: 10, reset: 0 } } } },
    errorsOnce: {
      [jobsPath]: "You have exceeded a secondary rate limit (HTTP 403)",
    },
  })
  assert.equal(secondary.status, 0, secondary.stderr)
  assert.deepEqual(secondary.sleeps, ["60"])
  // A reset more than 5 minutes away: no wait.
  const far = readJobs({
    api: {
      rate_limit: {
        resources: {
          core: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    },
    errorsOnce: { [jobsPath]: "API rate limit exceeded (HTTP 403)" },
  })
  assert.notEqual(far.status, 0)
  assert.doesNotMatch(far.stderr, /runs again/)
  assert.deepEqual(far.sleeps, [])
  // The call hits the limit, then a server error: not a rate limit.
  const broken = readJobs({
    errorsOnce: { [jobsPath]: "API rate limit exceeded (HTTP 403)" },
    errors: { [jobsPath]: "gh: Server Error (HTTP 500)" },
  })
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /HTTP 500/)
  assert.deepEqual(broken.sleeps, ["1"])
})

test("the merge gate posts no PR comment, and its job summary and artifact hold the report", () => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  const job = workflow.jobs["merge-gate"]
  // The job only reads the PR: it writes no comment.
  assert.equal(job.permissions["pull-requests"], "read")
  const step = (name) => job.steps.find((item) => item.name === name)
  assert.match(step("Decision").run, /summary\.md" >> "\$GITHUB_STEP_SUMMARY"/)
  assert.match(step("Preserve the decision").with.path, /decision\/summary\.md/)
  // No step of the workflow calls the GitHub API to list the PR files.
  assert.doesNotMatch(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
    /pulls\/\$PR\/files/,
  )
})

test("one CI run for each commit of a PR, and a cancelled run fails only the Merge gate", () => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  // A draft PR runs CI too. A run for `ready_for_review` would only repeat
  // the run of the same commit, and cancel it (CTX-1307).
  assert.deepEqual(workflow.on.pull_request.types, [
    "opened",
    "reopened",
    "synchronize",
  ])
  // Tests is not a required check: a cancelled run skips it.
  assert.match(workflow.jobs.test.if, /^!cancelled\(\) &&/)
  // The required check: a skipped one counts as a pass, so it also runs,
  // and fails, in a cancelled run.
  assert.match(workflow.jobs["merge-gate"].if, /^always\(\) &&/)
})
