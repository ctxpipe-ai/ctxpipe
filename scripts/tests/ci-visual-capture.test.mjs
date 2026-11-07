import assert from "node:assert/strict"
import { test } from "node:test"

import { shootUntilSteady } from "../ci/visual-capture.mjs"

// Gives the shots of a page whose pixels change in the given order, and
// counts the pauses between shots.
const page = (...frames) => {
  let taken = 0
  let paused = 0
  return {
    shoot: async () =>
      Buffer.from(frames[Math.min(taken++, frames.length - 1)]),
    pause: async () => {
      paused++
    },
    taken: () => taken,
    paused: () => paused,
  }
}

test("a page that does not change gives its shot after two shots", async () => {
  const steady = page("a")
  const result = await shootUntilSteady(steady.shoot, steady.pause)
  assert.deepEqual(result, { steady: true, png: Buffer.from("a") })
  assert.equal(steady.taken(), 2)
  assert.equal(steady.paused(), 0)
})

test("a late change is waited for until two shots in a row match", async () => {
  const late = page("a", "b", "b")
  const result = await shootUntilSteady(late.shoot, late.pause)
  assert.deepEqual(result, { steady: true, png: Buffer.from("b") })
  assert.equal(late.taken(), 3)
  // A shot that differs gives a slow change time to end before the next.
  assert.equal(late.paused(), 1)
})

test("a page that keeps changing is unstable after the last shot", async () => {
  const moving = page("a", "b", "c", "d", "e", "f", "g")
  const result = await shootUntilSteady(moving.shoot, moving.pause)
  assert.deepEqual(result, { steady: false, png: Buffer.from("f") })
  assert.equal(moving.taken(), 6)
  assert.equal(moving.paused(), 4)
})
