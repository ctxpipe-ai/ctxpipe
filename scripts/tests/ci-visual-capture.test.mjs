import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { readUnstableList } from "../checks/visual.mjs"
import { judgeProof } from "../ci/visual-capture-proof.mjs"
import { componentClip } from "../ci/visual-component-box.mjs"
import {
  captureWorkers,
  shootUntilSteady,
  splitPlan,
} from "../ci/visual-capture.mjs"

// Gives the shots of a page whose pixels change in the given order, and
// counts the pauses between shots.
const page = (...frames) => {
  let taken = 0
  let paused = 0
  return {
    shoot: async () => {
      const frame = frames[Math.min(taken++, frames.length - 1)]
      // A frame is the PNG, or `[png, area]` for a shot of a component.
      const [png, area] = Array.isArray(frame) ? frame : [frame]
      return { png: Buffer.from(png), area }
    },
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

test("a component that moves with the same pixels is not steady until it stops", async () => {
  const at = (y) => ({ x: 0, y, width: 100, height: 40 })
  const moving = page(["a", at(10)], ["a", at(20)], ["a", at(30)], ["a", at(30)])
  const result = await shootUntilSteady(moving.shoot, moving.pause)
  assert.deepEqual(result, { steady: true, png: Buffer.from("a") })
  assert.equal(moving.taken(), 4)
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
  // An empty list is valid: no story is known to be unstable.
  assert.ok(Array.isArray(readUnstableList(list)))
})

test("the capture gives each container 3 free CPUs of Docker, at most one container for each story", () => {
  assert.equal(captureWorkers({ cpus: 16, running: 0 }, 852), 5)
  // A 4-CPU CI runner keeps one container.
  assert.equal(captureWorkers({ cpus: 4, running: 0 }, 852), 1)
  assert.equal(captureWorkers({ cpus: 2, running: 0 }, 852), 1)
  assert.equal(captureWorkers({ cpus: 16, running: 0 }, 3), 3)
  assert.equal(captureWorkers({ cpus: 16, running: 0 }, 0), 1)
  // The capture containers of another run on the host use their CPUs.
  assert.equal(captureWorkers({ cpus: 16, running: 2 }, 852), 3)
  assert.equal(captureWorkers({ cpus: 16, running: 5 }, 852), 1)
  assert.equal(captureWorkers({ cpus: 16, running: 9 }, 852), 1)
})

test("the parts of a plan hold each story one time, and each part gets every n-th story", () => {
  const plan = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }))
  const parts = splitPlan(plan, 3)
  assert.deepEqual(
    parts.map((part) => part.map((story) => story.id).join("")),
    ["adg", "be", "cf"],
  )
  assert.deepEqual(
    parts
      .flat()
      .map((story) => story.id)
      .sort(),
    plan.map((story) => story.id),
  )
  assert.deepEqual(splitPlan(plan, 1), [plan])
})

const page1440 = { width: 1440, height: 900 }

test("a component shot is the union of the boxes with 16 px of padding, in whole pixels", () => {
  assert.deepEqual(
    componentClip(
      [
        { x: 100.4, y: 50, width: 200, height: 40.2 },
        // A popover below and to the right of its trigger.
        { x: 250, y: 100, width: 300, height: 120 },
      ],
      page1440,
    ),
    { x: 84, y: 34, width: 482, height: 202 },
  )
})

test("a component shot stays inside the page", () => {
  // The underlay of a modal covers the viewport: the shot is the full page.
  assert.deepEqual(
    componentClip([{ x: 0, y: 0, width: 1440, height: 900 }], page1440),
    { x: 0, y: 0, width: 1440, height: 900 },
  )
  // A drawer that slides in from the left is partly out of the page.
  assert.deepEqual(
    componentClip([{ x: -320, y: 10, width: 400, height: 100 }], page1440),
    { x: 0, y: 0, width: 96, height: 126 },
  )
})

test("a story with no visible box has no component area", () => {
  assert.equal(componentClip([], page1440), null)
  assert.equal(
    componentClip([{ x: 1500, y: 10, width: 40, height: 40 }], page1440),
    null,
  )
})
