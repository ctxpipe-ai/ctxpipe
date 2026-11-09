import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { readUnstableList } from "../checks/visual.mjs"
import { judgeProof, quarantineOf } from "../ci/visual-capture-proof.mjs"
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

const canvas = {
  id: "a--canvas",
  reason: "A WebGL canvas draws each frame.",
  ticket: "CTX-1",
}

test("a listed unstable story that differs is skipped, and any other story that differs fails", () => {
  const verdict = judgeProof(
    [
      { id: "a--canvas", identical: false },
      { id: "b--button", identical: false },
      { id: "c--card", identical: true },
    ],
    [canvas],
  )
  assert.deepEqual(
    verdict.skipped.map((result) => result.id),
    ["a--canvas"],
  )
  assert.deepEqual(
    verdict.failing.map((result) => result.id),
    ["b--button"],
  )
})

test("a listed story that is unstable only at mobile is not skipped in the desktop proof", () => {
  const verdict = judgeProof(
    [{ id: "a--canvas", identical: false }],
    [{ ...canvas, viewport: "mobile" }],
  )
  assert.deepEqual(
    verdict.failing.map((result) => result.id),
    ["a--canvas"],
  )
})

test("the viewport of an unstable entry is desktop or mobile", () => {
  for (const viewport of ["desktop", "mobile"])
    assert.doesNotThrow(() =>
      readUnstableList({ stories: [{ ...canvas, viewport }] }),
    )
  assert.throws(
    () => readUnstableList({ stories: [{ ...canvas, viewport: "tablet" }] }),
    /viewport/,
  )
})

test("each entry of the unstable list needs a story id, a reason and a ticket", () => {
  assert.deepEqual(readUnstableList({ stories: [canvas] }), [canvas])
  for (const missing of ["id", "reason", "ticket"]) {
    const entry = { ...canvas }
    delete entry[missing]
    assert.throws(() => readUnstableList({ stories: [entry] }), /needs/)
  }
  assert.throws(
    () => readUnstableList({ stories: [{ ...canvas, ticket: "soon" }] }),
    /needs/,
  )
})

test("the committed unstable list is valid", () => {
  const list = JSON.parse(
    readFileSync(
      new URL("../ci/visual-unstable-stories.json", import.meta.url),
      "utf8",
    ),
  )
  assert.ok(readUnstableList(list).length > 0)
})

test("only a story whose two captures gave different images is quarantined, with its desktop baseline", () => {
  const run = (status, sha256) => ({ status, ...(sha256 && { sha256 }) })
  const entries = new Map(
    ["a--one", "b--two", "c--three", "d--four"].map((id) => [
      id,
      { id, importPath: "./src/x/Card.stories.tsx", exportName: id.slice(3) },
    ]),
  )
  const quarantined = quarantineOf(
    [
      { id: "a--one", runs: [run("captured", "1"), run("captured", "2")] },
      { id: "b--two", runs: [run("captured", "1"), run("unstable")] },
      // A broken story, not an unstable screenshot.
      { id: "c--three", runs: [run("play-failed"), run("play-failed")] },
      { id: "d--four", runs: [run("captured", "1"), run("missing")] },
    ],
    entries,
  )
  assert.deepEqual(quarantined, [
    {
      id: "a--one",
      baseline: "apps/ui/src/x/screenshots/Card.one.desktop.screenshot.png",
    },
    {
      id: "b--two",
      baseline: "apps/ui/src/x/screenshots/Card.two.desktop.screenshot.png",
    },
  ])
})
