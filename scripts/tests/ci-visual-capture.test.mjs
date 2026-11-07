import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { shootUntilSteady } from "../ci/visual-capture.mjs"

// Gives the shots of a page whose pixels change in the given order.
const page = (...frames) => {
  let taken = 0
  return {
    shoot: async () => Buffer.from(frames[Math.min(taken++, frames.length - 1)]),
    taken: () => taken,
  }
}

test("a page that does not change gives its shot after two shots", async () => {
  const steady = page("a")
  const result = await shootUntilSteady(steady.shoot, 4)
  assert.deepEqual(result, { steady: true, png: Buffer.from("a") })
  assert.equal(steady.taken(), 2)
})

test("a late change is waited for until two shots in a row match", async () => {
  const late = page("a", "b", "b")
  const result = await shootUntilSteady(late.shoot, 4)
  assert.deepEqual(result, { steady: true, png: Buffer.from("b") })
  assert.equal(late.taken(), 3)
})

test("a page that keeps changing is unstable after the last shot", async () => {
  const moving = page("a", "b", "c", "d", "e")
  const result = await shootUntilSteady(moving.shoot, 4)
  assert.deepEqual(result, { steady: false, png: Buffer.from("d") })
  assert.equal(moving.taken(), 4)
})

test("the nightly run captures a sample two times and fails on a difference", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yaml", import.meta.url),
    "utf8",
  )
  const job = /\n {2}visual-determinism:\n((?: {4}.*\n|\n)+)/.exec(
    workflow,
  )?.[1]
  assert.ok(job, "ci.yaml has no visual-determinism job")
  assert.match(job, /github\.event_name == 'schedule'/)
  assert.doesNotMatch(job, /pull_request/)
  assert.match(job, /runs-on: .*-arm\n/)
  assert.match(job, /node scripts\/ci\/visual-capture-proof\.mjs \d+\n/)
})
