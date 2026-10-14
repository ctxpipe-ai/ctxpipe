import assert from "node:assert/strict"
import test from "node:test"
import { existingClaims } from "./knowledge-lib.mjs"

test("existingClaims rejects non-ASCII whitespace continuations", () => {
  const whitespace = [
    "\u00a0",
    "\u3000",
    "\u2000",
    "\u202f",
    "\ufeff",
    "\u1680",
    "\u205f",
    "\u000b",
    "\u000c",
    "\u200a",
  ]
  const cases = whitespace.flatMap((space) => [
    `claims:\n  - to: knowledge/a.md\n      ${space}\n    predicate: OWNS\n`,
    `claims:\n  - to: knowledge/a.md\n      ${space}#x\n    predicate: OWNS\n`,
  ])

  for (const yaml of cases) assert.equal(existingClaims(yaml), null)
})

test("existingClaims handles long inner spaces in a target", () => {
  const yaml = `claims:\n  - to: a${" ".repeat(200_000)}b\n    predicate: OWNS\n`
  assert.deepEqual(
    existingClaims(yaml),
    new Set([`a${" ".repeat(200_000)}b OWNS`]),
  )
})
