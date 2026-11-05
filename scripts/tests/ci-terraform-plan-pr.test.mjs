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
// GitHub API is the environment, so it is the only fake.

const root = fileURLToPath(new URL("../../", import.meta.url))
const repo = "acme/widgets"
const merge = "c".repeat(40)
const head = "a".repeat(40)

// `gh api <path> [--paginate|--silent] [--jq <expr>]` prints the file of that
// path (slashes become underscores), through jq when --jq is given, or fails
// with the text in `<name>.error`. `gh pr view` prints the state file.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_GH_DIR"
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

// The shell of the step that looks for a change under infra/, as ci.yaml holds
// it.
const startStep = () => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  const step = workflow.jobs["merge-gate-terraform-changes"].steps.find(
    ({ name }) => name === "Look for a change under infra/",
  )
  return step.run
}

const run = (script, dir, env, args = []) => {
  const output = join(dir, "github-output")
  writeFileSync(output, "")
  const command =
    script === "start-terraform-plan"
      ? ["-c", `set -eo pipefail\n${startStep()}`]
      : [join(root, "scripts/ci", script), ...args]
  const result = spawnSync("bash", command, {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE_GH_DIR: dir,
      GITHUB_OUTPUT: output,
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readFileSync(output, "utf8").trim().split("\n").filter(Boolean),
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

const files = (...names) => names.map((filename) => ({ filename }))
const start = (names, options = {}) =>
  run(
    "start-terraform-plan",
    setup({
      api: {
        [`repos/${repo}/pulls/7/files`]: files(...names),
        [`repos/${repo}/branches/feature`]: {},
      },
      ...options,
    }),
    { REPO: repo, PR: "7", BRANCH: "feature" },
  )

test("the plan is called for a change under infra/, whatever else changes", () => {
  for (const names of [
    ["infra/main.tf"],
    ["pnpm-lock.yaml", "infra/modules/a/main.tf"],
  ]) {
    const result = start(names)
    assert.equal(result.status, 0)
    assert.deepEqual(result.outputs, ["plan=false", "plan=true"])
  }
})

test("the plan is called when a file moves out of infra/", () => {
  const result = run(
    "start-terraform-plan",
    setup({
      api: {
        [`repos/${repo}/pulls/7/files`]: [
          { filename: "modules/a.tf", previous_filename: "infra/a.tf" },
        ],
        [`repos/${repo}/branches/feature`]: {},
      },
    }),
    { REPO: repo, PR: "7", BRANCH: "feature" },
  )
  assert.equal(result.status, 0)
  assert.equal(result.outputs.at(-1), "plan=true")
})

test("the plan is not called for a PR with no change under infra/", () => {
  for (const names of [
    ["pnpm-lock.yaml"],
    ["package.json", "apps/backend/src/a.ts"],
    ["docs/infra/readme.md", "apps/infra/main.tf"],
  ]) {
    const result = start(names)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /no file under infra\//)
    assert.deepEqual(result.outputs, ["plan=false"])
  }
})

test("the plan is not called for a closed PR", () => {
  const result = start(["infra/main.tf"], { state: "MERGED" })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /PR is closed/)
  assert.deepEqual(result.outputs, ["plan=false"])
})

test("the plan is not called when the branch is gone, and the step fails on another error", () => {
  const gone = start(["infra/main.tf"], {
    errors: { [`repos/${repo}/branches/feature`]: "gh: Not Found (HTTP 404)" },
  })
  assert.equal(gone.status, 0)
  assert.match(gone.stdout, /closed or its branch is gone/)
  assert.deepEqual(gone.outputs, ["plan=false"])
  const broken = start(["infra/main.tf"], {
    errors: {
      [`repos/${repo}/branches/feature`]: "gh: Server Error (HTTP 500)",
    },
  })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /HTTP 500/)
  assert.deepEqual(broken.outputs, ["plan=false"])
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

test("the evals reminder shows when a file moves out of apps/backend/src/mcp/", () => {
  const dir = setup({
    api: {
      [`repos/${repo}/pulls/7/files`]: [
        {
          filename: "apps/backend/src/tools.ts",
          previous_filename: "apps/backend/src/mcp/tools.ts",
        },
      ],
      [`repos/${repo}/issues/7/labels`]: [],
    },
  })
  const comment = join(dir, "comment.md")
  writeFileSync(comment, "<!-- merge-gate -->\n")
  run("mcp-evals-reminder.sh", dir, { REPO: repo, PR: "7" }, [comment])
  assert.match(readFileSync(comment, "utf8"), /\*\*MCP evals:\*\*/)
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
