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

// The Terraform plan start and the MCP evals reminder (scripts/checks/README.md,
// Other pull request workflows). Each runs as the workflow runs it (a script,
// or the `run` text of the step in ci.yaml), with a `gh` on PATH that answers from files: the
// GitHub API is the environment, so it is the only fake. The changed paths
// come from a real git repository with a merge revision, as CI checks it out.

const root = fileURLToPath(new URL("../../", import.meta.url))
const repo = "acme/widgets"
const merge = "c".repeat(40)
const head = "a".repeat(40)

// `gh api <path> [--paginate|--silent] [--jq <expr>]` prints the file of that
// path (slashes become underscores), through jq when --jq is given, or fails
// with the text in `<name>.error`, or one time with the text in
// `<name>.error-once`. `gh workflow run` and `gh api --method <verb>` append
// their arguments to calls.log. The fake `sleep` appends its argument to
// sleeps.log and does not wait.
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
if [ "$1" = workflow ] || [ "$2" = --method ]; then
  echo "$*" >> "$dir/calls.log"
  exit 0
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
  state = "open",
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "terraform-plan-"))
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
  // The state of the PR, as the REST API gives it.
  const pull = join(dir, `${file(`repos/${repo}/pulls/7`)}.json`)
  if (!existsSync(pull)) writeFileSync(pull, JSON.stringify({ state }))
  return dir
}

// The shell of a step of ci.yaml, as the workflow holds it.
const stepShell = (job, stepName) => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  return workflow.jobs[job].steps.find(({ name }) => name === stepName).run
}

const steps = {
  "start-terraform-plan": [
    "merge-gate-critics",
    "Look for a change under infra/",
  ],
  "post-comment": ["merge-gate", "Post or update the PR comment"],
  "jobs-of-the-run": ["merge-gate", "The jobs of this run"],
}

const run = (script, dir, env, args = [], cwd = undefined) => {
  const log = (name) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").trim().split("\n")
      : []
  const output = join(dir, "github-output")
  writeFileSync(output, "")
  const command =
    script in steps
      ? ["-c", `set -eo pipefail\n${stepShell(...steps[script])}`]
      : [join(root, "scripts/ci", script), ...args]
  const result = spawnSync("bash", command, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE_GH_DIR: dir,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: dir,
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readFileSync(output, "utf8").trim().split("\n").filter(Boolean),
    calls: log("calls.log"),
    sleeps: log("sleeps.log"),
  }
}

const pull = (patch = {}) => ({
  head: { repo: { full_name: repo }, ref: "feature", sha: head },
  base: { sha: "b".repeat(40) },
  merge_commit_sha: merge,
  ...patch,
})

const resolve = (body, env = {}, parents = [head]) =>
  run(
    "resolve-terraform-plan-pr.sh",
    setup({
      api: {
        [`repos/${repo}/pulls/7`]: body,
        [`repos/${repo}/commits/${merge}`]: {
          parents: parents.map((sha) => ({ sha })),
        },
      },
    }),
    {
      REPO: repo,
      INPUT_PR_NUMBER: "7",
      BRANCH: "feature",
      REF: "refs/heads/feature",
      RUN_SHA: head,
      ...env,
    },
  )

test("resolve refuses an input that is not a number", () => {
  for (const input of ["", "7; rm -rf /", "$(id)", "7 8", "-1"]) {
    const result = resolve(pull(), { INPUT_PR_NUMBER: input })
    assert.equal(result.status, 1, input)
    assert.match(result.stderr, /must be a number/, input)
    assert.deepEqual(result.outputs, [], input)
  }
})

test("resolve refuses a fork PR", () => {
  const result = resolve(
    pull({
      head: { repo: { full_name: "evil/widgets" }, ref: "feature", sha: head },
    }),
  )
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Refusing to plan fork PR #7/)
  assert.deepEqual(result.outputs, [])
})

test("resolve refuses a PR whose repository is gone", () => {
  const result = resolve(
    pull({ head: { repo: null, ref: "feature", sha: head } }),
  )
  assert.equal(result.status, 1)
  assert.deepEqual(result.outputs, [])
})

test("resolve refuses a run from another ref than the PR branch", () => {
  for (const env of [
    { BRANCH: "main", REF: "refs/heads/main" },
    { REF: "refs/tags/feature" },
    { BRANCH: "feature", REF: "refs/heads/other" },
    { REF: "refs/pull/8/merge" },
    { REF: "refs/pull/7/head" },
  ]) {
    const result = resolve(pull(), env)
    assert.equal(result.status, 1, JSON.stringify(env))
    assert.match(result.stdout, /Run this workflow from the branch of PR #7/)
    assert.deepEqual(result.outputs, [])
  }
})

test("resolve accepts a call from the merge ref of the PR", () => {
  const result = resolve(pull(), { REF: "refs/pull/7/merge" })
  assert.equal(result.status, 0)
  assert.ok(result.outputs.includes("current=true"))
})

test("resolve outputs the merge commit and the base for the current head", () => {
  const result = resolve(pull())
  assert.equal(result.status, 0)
  assert.deepEqual(result.outputs, [
    `base_sha=${"b".repeat(40)}`,
    `merge_sha=${merge}`,
    "current=true",
  ])
})

test("resolve marks a run stale when the PR head moved on", () => {
  const moved = "d".repeat(40)
  const result = resolve(
    pull({ head: { repo: { full_name: repo }, ref: "feature", sha: moved } }),
    {},
    [moved],
  )
  assert.equal(result.status, 0)
  assert.ok(result.outputs.includes("current=false"))
  assert.ok(result.outputs.includes(`merge_sha=${merge}`))
})

test("resolve fails when the merge commit does not hold the PR head", () => {
  const result = resolve(pull(), {}, ["e".repeat(40), "f".repeat(40)])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /does not hold its head yet/)
  assert.deepEqual(result.outputs, [])
})

test("resolve fails when the PR has no merge commit", () => {
  for (const merge_commit_sha of [null, "", "not-a-sha"]) {
    const result = resolve(pull({ merge_commit_sha }))
    assert.equal(result.status, 1, String(merge_commit_sha))
    assert.match(result.stdout, /has no merge commit/)
    assert.deepEqual(result.outputs, [])
  }
})

// A git repository whose HEAD is the merge revision of a PR, as the checkout
// of a pull_request run: its first parent is main, which moved on after the
// branch started. `change` runs on the PR branch: write a file with
// `write`, move one with `move`, delete one with `remove`.
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")}: ${result.stdout}${result.stderr}`,
  )
  return result.stdout
}
const mergeRevision = (change) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-revision-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "ci@example.com")
  git(dir, "config", "user.name", "CI")
  const write = (path, text = path) => {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), `${text}\n`)
  }
  for (const path of [
    "README.md",
    "infra/a.tf",
    "infra/old.tf",
    "docs/infra/readme.md",
    "apps/backend/src/mcp/index.ts",
    "apps/backend/src/mcp/tools.ts",
  ])
    write(path)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "base")
  git(dir, "checkout", "-q", "-b", "feature")
  change({
    write,
    move: (from, to) => {
      mkdirSync(join(dir, to, ".."), { recursive: true })
      git(dir, "mv", from, to)
    },
    remove: (path) => git(dir, "rm", "-q", path),
  })
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "change")
  // main moves on with an infra/ change of its own: it is not a PR change.
  git(dir, "checkout", "-q", "main")
  write("infra/main-only.tf")
  write("apps/backend/src/mcp/main-only.ts")
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", "main")
  git(dir, "merge", "-q", "--no-ff", "-m", "merge", "feature")
  return dir
}

const start = (change, options = {}, branch = "feature") =>
  run(
    "start-terraform-plan",
    setup({
      api: {
        [`repos/${repo}/branches/${encodeURIComponent(branch)}`]: {},
        rate_limit: { resources: { core: { remaining: 0, reset: 0 } } },
      },
      ...options,
    }),
    { REPO: repo, PR: "7", BRANCH: branch },
    [],
    mergeRevision(change),
  )

test("the plan is called for a change under infra/, whatever else changes", () => {
  for (const change of [
    ({ write }) => write("infra/a.tf", "changed"),
    ({ write }) => {
      write("pnpm-lock.yaml")
      write("infra/modules/a/main.tf")
    },
    ({ remove }) => remove("infra/old.tf"),
  ]) {
    const result = start(change)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.outputs, ["plan=false", "plan=true"])
  }
})

test("the plan is called when a file moves out of infra/", () => {
  const result = start(({ move }) => move("infra/old.tf", "modules/old.tf"))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.at(-1), "plan=true")
})

test("the plan is not called for a PR with no change under infra/", () => {
  for (const change of [
    ({ write }) => write("pnpm-lock.yaml"),
    ({ write }) => {
      write("package.json")
      write("apps/backend/src/a.ts")
    },
    ({ write }) => {
      write("docs/infra/readme.md", "changed")
      write("apps/infra/main.tf")
    },
  ]) {
    const result = start(change)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /no file under infra\//)
    assert.deepEqual(result.outputs, ["plan=false"])
  }
})

test("a rate limit makes the step wait for the reset and call again", () => {
  const result = start(({ write }) => write("infra/a.tf", "changed"), {
    errorsOnce: {
      [`repos/${repo}/pulls/7`]:
        "API rate limit exceeded for installation ID 1 (HTTP 403)",
      [`repos/${repo}/branches/feature`]:
        "API rate limit exceeded for installation ID 1 (HTTP 403)",
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /the call runs again in 1s/)
  assert.deepEqual(result.sleeps, ["1", "1"])
  assert.deepEqual(result.outputs, ["plan=false", "plan=true"])
})

test("a rate limit that stays skips the plan with a warning, and does not fail the step", () => {
  const limit = "API rate limit exceeded for installation ID 1 (HTTP 403)"
  for (const errors of [
    { [`repos/${repo}/pulls/7`]: limit },
    { [`repos/${repo}/branches/feature`]: limit },
  ]) {
    const result = start(({ write }) => write("infra/a.tf", "changed"), {
      errors,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /::warning::The GitHub API rate limit stays/)
    assert.deepEqual(result.outputs, ["plan=false"])
  }
  // A reset more than 5 minutes away: no wait, and no failure.
  const far = start(({ write }) => write("infra/a.tf", "changed"), {
    api: {
      rate_limit: {
        resources: {
          core: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    },
    errorsOnce: { [`repos/${repo}/pulls/7`]: limit },
  })
  assert.equal(far.status, 0, far.stderr)
  assert.doesNotMatch(far.stderr, /runs again/)
  assert.deepEqual(far.sleeps, [])
  assert.match(far.stdout, /rate limit stays/)
})

const infraChange = ({ write }) => write("infra/main.tf")

test("a secondary rate limit waits one minute, and another error after the wait fails the step", () => {
  const secondary = start(({ write }) => write("infra/a.tf", "changed"), {
    api: {
      [`repos/${repo}/branches/feature`]: {},
      rate_limit: { resources: { core: { remaining: 10, reset: 0 } } },
    },
    errorsOnce: {
      [`repos/${repo}/pulls/7`]:
        "You have exceeded a secondary rate limit (HTTP 403)",
    },
  })
  assert.equal(secondary.status, 0, secondary.stderr)
  assert.deepEqual(secondary.sleeps, ["60"])
  assert.equal(secondary.outputs.at(-1), "plan=true")
  // The branch call hits the limit, then a server error: not a rate limit.
  const branch = `repos/${repo}/branches/feature`
  const broken = start(infraChange, {
    errorsOnce: { [branch]: "API rate limit exceeded (HTTP 403)" },
    errors: { [branch]: "gh: Server Error (HTTP 500)" },
  })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /HTTP 500/)
  assert.doesNotMatch(broken.stdout, /rate limit stays/)
})

test("each step that calls the GitHub API holds the same gh_retry", () => {
  const all = Object.values(steps)
  const texts = all.map((step) => {
    const text = stepShell(...step)
    const from = text.indexOf("# gh_retry runs")
    assert.ok(from >= 0, step.join(": "))
    return text.slice(from, text.indexOf("\n}\n", from) + 3)
  })
  for (const [index, text] of texts.entries())
    assert.equal(text, texts[0], all[index].join(": "))
  // No step of the workflow calls the GitHub API to list the PR files.
  assert.doesNotMatch(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
    /pulls\/\$PR\/files/,
  )
})

test("a path that git quotes still counts as a change under infra/", () => {
  const result = start(({ write }) => write('infra/café "x".tf'))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.at(-1), "plan=true")
})

test("the plan is not called for a closed PR", () => {
  const result = start(infraChange, { state: "closed" })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /PR is closed/)
  assert.deepEqual(result.outputs, ["plan=false"])
})

test("the plan is not called when the branch is gone, and the step fails on another error", () => {
  const gone = start(infraChange, {
    errors: { [`repos/${repo}/branches/feature`]: "gh: Not Found (HTTP 404)" },
  })
  assert.equal(gone.status, 0)
  assert.match(gone.stdout, /closed or its branch is gone/)
  assert.deepEqual(gone.outputs, ["plan=false"])
  const broken = start(infraChange, {
    errors: {
      [`repos/${repo}/branches/feature`]: "gh: Server Error (HTTP 500)",
    },
  })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /HTTP 500/)
  assert.deepEqual(broken.outputs, ["plan=false"])
})

test("the Terraform changes step looks up a branch with a slash by its encoded name", () => {
  const terraform = start(infraChange, {}, "jakub/ctx-1-topic")
  assert.equal(terraform.status, 0, terraform.stderr)
  assert.equal(terraform.outputs.at(-1), "plan=true")
})

const remind = ({ change, labels }) => {
  const dir = setup({
    api: {
      [`repos/${repo}/issues/7/labels`]: labels.map((name) => ({ name })),
    },
  })
  const comment = join(dir, "comment.md")
  writeFileSync(comment, "<!-- merge-gate -->\n### Merge gate\n")
  const result = run(
    "mcp-evals-reminder.sh",
    dir,
    { REPO: repo, PR: "7" },
    [comment],
    mergeRevision(change),
  )
  return { ...result, comment: readFileSync(comment, "utf8") }
}

test("the evals reminder shows for a change under apps/backend/src/mcp/ without the label", () => {
  for (const change of [
    ({ write }) => write("apps/backend/src/mcp/tools.ts", "changed"),
    ({ write }) => {
      write("pnpm-lock.yaml")
      write("apps/backend/src/mcp/nested/a.ts")
    },
    // A file that moves out of apps/backend/src/mcp/ counts at its old path.
    ({ move }) =>
      move("apps/backend/src/mcp/tools.ts", "apps/backend/src/tools.ts"),
  ]) {
    const result = remind({ change, labels: ["bug"] })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.comment, /\*\*MCP evals:\*\*/)
    assert.match(result.comment, /label `mcp-evals`/)
  }
})

test("the evals reminder stays away with the label or without an MCP change", () => {
  const labeled = remind({
    change: ({ write }) => write("apps/backend/src/mcp/tools.ts", "changed"),
    labels: ["bug", "mcp-evals"],
  })
  assert.equal(labeled.status, 0, labeled.stderr)
  assert.doesNotMatch(labeled.comment, /MCP evals/)
  for (const change of [
    ({ write }) => write("pnpm-lock.yaml"),
    ({ write }) => {
      write("apps/backend/src/mcp-other/a.ts")
      write("apps/backend/evals/mcp/cases.ts")
    },
  ]) {
    const result = remind({ change, labels: [] })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.comment, /MCP evals/)
  }
})

const postComment = (options) => {
  const dir = setup({
    api: {
      [`repos/${repo}/issues/7/comments`]: [
        {
          id: 5,
          user: { login: "github-actions[bot]" },
          body: "<!-- merge-gate -->\nold",
        },
      ],
      rate_limit: { resources: { core: { remaining: 0, reset: 0 } } },
    },
    ...options,
  })
  mkdirSync(join(dir, "decision"))
  writeFileSync(join(dir, "decision/comment.md"), "<!-- merge-gate -->\nnew")
  return run("post-comment", dir, { REPO: repo, PR: "7" })
}

test("the PR comment waits for the rate limit reset, and a limit that stays does not fail the job", () => {
  const limit = "API rate limit exceeded for installation ID 1 (HTTP 403)"
  const once = postComment({
    errorsOnce: { [`repos/${repo}/issues/7/comments`]: limit },
  })
  assert.equal(once.status, 0, once.stderr)
  assert.match(once.stderr, /the call runs again in 1s/)
  assert.deepEqual(once.sleeps, ["1"])
  assert.equal(
    once.calls[0],
    `api --method PATCH repos/${repo}/issues/comments/5 -f body=<!-- merge-gate -->`,
  )
  const stays = postComment({
    errors: { [`repos/${repo}/issues/7/comments`]: limit },
  })
  assert.equal(stays.status, 0, stays.stderr)
  assert.match(stays.stdout, /::warning::The GitHub API rate limit stays/)
  assert.deepEqual(stays.calls, [])
  const broken = postComment({
    errors: {
      [`repos/${repo}/issues/7/comments`]: "gh: Server Error (HTTP 500)",
    },
  })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /HTTP 500/)
})

test("the evals reminder writes nothing when the comment file is missing", () => {
  const dir = setup()
  const comment = join(dir, "missing.md")
  const result = run("mcp-evals-reminder.sh", dir, { REPO: repo, PR: "7" }, [
    comment,
  ])
  assert.equal(result.status, 0)
  assert.equal(existsSync(comment), false)
})
