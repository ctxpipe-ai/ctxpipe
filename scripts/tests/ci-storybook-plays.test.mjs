import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  selectRequiredStories,
  selectPlayStories,
  shardStories,
} from "../ci/storybook-select.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

test("inventory rejects a tagged required story without play-fn", () => {
  assert.throws(
    () =>
      selectRequiredStories({
        entries: {
          remap: { id: "a--b", exportName: "B", tags: ["required"] },
        },
      }),
    /no play function/,
  )
})

test("the required tag is the whole required set, sorted by id", () => {
  const index = {
    entries: {
      c: { id: "c--one", exportName: "One", tags: ["required", "play-fn"] },
      a: { id: "a--one", exportName: "One", tags: ["required", "play-fn"] },
      b: { id: "b--one", exportName: "One", tags: ["play-fn"] },
    },
  }
  assert.deepEqual(
    selectRequiredStories(index).map((story) => story.id),
    ["a--one", "c--one"],
  )
})

test("CI requires the Storybook required plays job without retries", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yaml", import.meta.url),
    "utf8",
  )
  assert.match(workflow, /name: Storybook required plays/)
  assert.match(workflow, /node scripts\/ci\/storybook-plays\.mjs/)
  assert.doesNotMatch(workflow, /--retry/)
  // storybook-plays.mjs plays the stories with storybook-play.mjs.
  const runner = readFileSync(
    new URL("../../scripts/ci/storybook-play.mjs", import.meta.url),
    "utf8",
  )
  const select = readFileSync(
    new URL("../../scripts/ci/storybook-select.mjs", import.meta.url),
    "utf8",
  )
  assert.match(select, /required/)
  assert.match(select, /play-fn/)
  assert.match(runner, /playwright/)
  assert.doesNotMatch(runner, /--retry(?:ies)?(?:=|\s+)/)
  void root
})

test("a story with a play function ends when its play ends; a story without one ends when it is completed", async () => {
  const { storyEndPhase } = await import("../ci/storybook-play.mjs")
  // A story with a play that never ran also reaches "completed". It must not
  // pass, so only a story without a play function can end there.
  assert.equal(storyEndPhase({ tags: ["dev", "play-fn"] }), "played")
  assert.equal(storyEndPhase({ tags: ["dev", "test"] }), "completed")
  assert.equal(storyEndPhase({}), "completed")
})

test("the all-plays selection keeps every story with a play function, sorted", () => {
  const index = {
    entries: {
      b: { id: "b", type: "story", tags: ["play-fn"] },
      a: { id: "a", type: "story", tags: ["play-fn", "required"] },
      c: { id: "c", type: "story", tags: [] },
      d: { id: "d", type: "docs", tags: ["play-fn"] },
    },
  }
  assert.deepEqual(
    selectPlayStories(index).map((story) => story.id),
    ["a", "b"],
  )
})

test("shards cover every story exactly once", () => {
  const stories = Array.from({ length: 10 }, (_, at) => ({ id: `s${at}` }))
  const shards = [1, 2, 3].map((at) => shardStories(stories, `${at}/3`))
  assert.deepEqual(
    shards
      .flat()
      .map((story) => story.id)
      .sort(),
    stories.map((story) => story.id).sort(),
  )
  assert.equal(shardStories(stories, undefined), stories)
  assert.throws(() => shardStories(stories, "0/3"))
  assert.throws(() => shardStories(stories, "4/3"))
  assert.throws(() => shardStories(stories, "x"))
})

test("CI runs every story with a play function in shards", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yaml", import.meta.url),
    "utf8",
  )
  assert.match(workflow, /name: Storybook Playwright all plays/)
  assert.match(workflow, /STORYBOOK_PLAYS: all/)
  assert.match(workflow, /SKIP_STORYBOOK_BUILD: "1"/)
  assert.match(
    workflow,
    /name: Storybook build\n(?:.*\n)*? {4}runs-on: blacksmith-4vcpu-ubuntu-2404/,
  )
  assert.match(
    workflow,
    /STORYBOOK_SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.count \}\}/,
  )
  // The full run has four shards; in gate mode the plan job gives the shards.
  const shards = JSON.parse(
    /storybook-plays \|\| '(\[[^']*\])'/.exec(workflow)[1],
  )
  assert.deepEqual(
    shards.map(({ shard, count }) => `${shard}/${count}`),
    ["1/4", "2/4", "3/4", "4/4"],
  )
})

test("a failed run exits at once instead of waiting on the open server", () => {
  const runner = readFileSync(
    new URL("../ci/storybook-plays.mjs", import.meta.url),
    "utf8",
  )
  assert.match(runner, /catch \(error\) \{[\s\S]*process\.exit\(1\)/)
})

test("every script that ci.yaml runs for a Storybook job is a Storybook check input", async () => {
  const { inputs } = await import("../checks/storybook.mjs")
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const scripts = new Set(
    [...workflow.matchAll(/node (scripts\/ci\/storybook[\w-]*\.mjs)/g)].map(
      (match) => match[1],
    ),
  )
  assert.ok(scripts.size > 0)
  for (const script of scripts) assert.ok(inputs.includes(script), script)
})

test("every scripts/ci file that the play runner reads at run time is a Storybook check input", async () => {
  const { inputs } = await import("../checks/storybook.mjs")
  const runner = readFileSync(
    join(root, "scripts/ci/storybook-plays.mjs"),
    "utf8",
  )
  const paths = new Set(
    [...runner.matchAll(/"(scripts\/ci\/[\w./-]+\.(?:mjs|json))"/g)].map(
      (match) => match[1],
    ),
  )
  assert.ok(paths.has("scripts/ci/failures/storybook-required.json"))
  for (const path of paths) assert.ok(inputs.includes(path), path)
})
