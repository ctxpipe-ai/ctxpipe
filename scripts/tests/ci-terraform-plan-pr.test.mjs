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

// The scripts that start the Terraform plan and the MCP evals reminder
// (scripts/checks/README.md, Other pull request workflows). Each script runs
// as the workflow runs it, with a `gh` on PATH that answers from files: the
// GitHub API is the environment, so it is the only fake.

const root = fileURLToPath(new URL("../../", import.meta.url))
const repo = "acme/widgets"
const merge = "c".repeat(40)
const head = "a".repeat(40)

// `gh api <path> [--paginate|--silent] [--jq <expr>]` prints the file of that
// path (slashes become underscores), through jq when --jq is given, or fails
// with the text in `<name>.error`. `gh pr view` prints the state file.
// `gh workflow run` appends its arguments to calls.log.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_GH_DIR"
if [ "$1" = workflow ]; then
  echo "$*" >> "$dir/calls.log"
  exit 0
fi
if [ "$1" = pr ]; then
  cat "$dir/pr-state"
  exit 0
fi
name="$(printf '%s' "$2" | tr '/' '_')"
expr=""
args=("\${@:3}")
for ((i = 0; i < \${#args[@]}; i++)); do
  [ "\${args[$i]}" = --jq ] && expr="\${args[$((i + 1))]}"
done
if [ -f "$dir/$name.error" ]; then
  cat "$dir/$name.error" >&2
  exit 1
fi
if [ -n "$expr" ]; then jq -r "$expr" "$dir/$name.json"; else cat "$dir/$name.json"; fi
`

const setup = ({ api = {}, errors = {}, state = "OPEN" } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "terraform-plan-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "gh"), fakeGh)
  chmodSync(join(bin, "gh"), 0o755)
  const file = (path) => path.replaceAll("/", "_")
  for (const [path, body] of Object.entries(api))
    writeFileSync(join(dir, `${file(path)}.json`), JSON.stringify(body))
  for (const [path, text] of Object.entries(errors))
    writeFileSync(join(dir, `${file(path)}.error`), text)
  writeFileSync(join(dir, "pr-state"), state)
  return dir
}

const run = (script, dir, env, args = []) => {
  const output = join(dir, "github-output")
  writeFileSync(output, "")
  const result = spawnSync(
    "bash",
    [join(root, "scripts/ci", script), ...args],
    {
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        FAKE_GH_DIR: dir,
        GITHUB_OUTPUT: output,
        ...env,
      },
    },
  )
  const calls = join(dir, "calls.log")
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readFileSync(output, "utf8").trim().split("\n").filter(Boolean),
    calls: existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n")
      : [],
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
  ]) {
    const result = resolve(pull(), env)
    assert.equal(result.status, 1, JSON.stringify(env))
    assert.match(result.stdout, /Run this workflow from the branch of PR #7/)
    assert.deepEqual(result.outputs, [])
  }
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

const files = (...names) => names.map((filename) => ({ filename }))
const start = (names, options = {}) =>
  run(
    "start-terraform-plan.sh",
    setup({
      api: {
        [`repos/${repo}/pulls/7/files`]: files(...names),
        [`repos/${repo}/branches/feature`]: {},
      },
      ...options,
    }),
    { REPO: repo, BRANCH: "feature", PR: "7" },
  )

test("the plan starts for a change under infra/, whatever else changes", () => {
  for (const names of [
    ["infra/main.tf"],
    ["pnpm-lock.yaml", "infra/modules/a/main.tf"],
  ]) {
    const result = start(names)
    assert.equal(result.status, 0)
    assert.deepEqual(result.calls, [
      `workflow run terraform-plan-pr.yaml --repo ${repo} --ref feature -f pr_number=7`,
    ])
  }
})

test("the plan does not start for a PR with no change under infra/", () => {
  for (const names of [
    ["pnpm-lock.yaml"],
    ["package.json", "apps/backend/src/a.ts"],
    ["docs/infra/readme.md", "apps/infra/main.tf"],
  ]) {
    const result = start(names)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /no file under infra\//)
    assert.deepEqual(result.calls, [])
  }
})

test("the plan does not start for a closed PR", () => {
  const result = start(["infra/main.tf"], { state: "MERGED" })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /closed or its branch is gone/)
  assert.deepEqual(result.calls, [])
})

test("the plan does not start when the branch is gone, and fails on another error", () => {
  const gone = start(["infra/main.tf"], {
    errors: { [`repos/${repo}/branches/feature`]: "gh: Not Found (HTTP 404)" },
  })
  assert.equal(gone.status, 0)
  assert.match(gone.stdout, /closed or its branch is gone/)
  assert.deepEqual(gone.calls, [])
  const broken = start(["infra/main.tf"], {
    errors: {
      [`repos/${repo}/branches/feature`]: "gh: Server Error (HTTP 500)",
    },
  })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /HTTP 500/)
  assert.deepEqual(broken.calls, [])
})

const remind = ({ names, labels }) => {
  const dir = setup({
    api: {
      [`repos/${repo}/pulls/7/files`]: files(...names),
      [`repos/${repo}/issues/7/labels`]: labels.map((name) => ({ name })),
    },
  })
  const comment = join(dir, "comment.md")
  writeFileSync(comment, "<!-- merge-gate -->\n### Merge gate\n")
  const result = run("mcp-evals-reminder.sh", dir, { REPO: repo, PR: "7" }, [
    comment,
  ])
  return { ...result, comment: readFileSync(comment, "utf8") }
}

test("the evals reminder shows for a change under apps/backend/src/mcp/ without the label", () => {
  for (const names of [
    ["apps/backend/src/mcp/tools.ts"],
    ["pnpm-lock.yaml", "apps/backend/src/mcp/nested/a.ts"],
  ]) {
    const result = remind({ names, labels: ["bug"] })
    assert.equal(result.status, 0)
    assert.match(result.comment, /\*\*MCP evals:\*\*/)
    assert.match(result.comment, /label `mcp-evals`/)
  }
})

test("the evals reminder stays away with the label or without an MCP change", () => {
  const labeled = remind({
    names: ["apps/backend/src/mcp/tools.ts"],
    labels: ["bug", "mcp-evals"],
  })
  assert.equal(labeled.status, 0)
  assert.doesNotMatch(labeled.comment, /MCP evals/)
  for (const names of [
    ["pnpm-lock.yaml"],
    ["apps/backend/src/mcp-other/a.ts", "apps/backend/evals/mcp/cases.ts"],
  ]) {
    const result = remind({ names, labels: [] })
    assert.equal(result.status, 0)
    assert.doesNotMatch(result.comment, /MCP evals/)
  }
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
