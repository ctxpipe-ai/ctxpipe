import { describe, expect, it } from "vitest"

import { baseBranchSchema } from "./conversation-base.js"

describe("baseBranchSchema", () => {
  it.each([
    "main",
    "release+hotfix",
    "release@2026",
    "feature/C++",
    "fix/#123",
    "docs/überblick",
    `feature/${"long-part/".repeat(40)}end`,
  ])("takes the Git branch name %s", (name) => {
    expect(baseBranchSchema.safeParse(name).success).toBe(true)
  })

  it.each([
    "",
    "-x",
    "a..b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a@{1}",
    "@",
    "/a",
    "a/",
    "a.",
    "a//b",
    "a/.b",
    "a.lock",
    "ctxpipe/chat/conv_1/1",
  ])("refuses %s", (name) => {
    expect(baseBranchSchema.safeParse(name).success).toBe(false)
  })
})
