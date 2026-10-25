import { describe, expect, it } from "vitest"

import { isHostOnlyPath } from "./host-only.js"
import {
  CODE_FORMAT,
  formatReadOnlyReason,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_INVALID,
  WORKSPACE_FORMAT_PATH,
  withFormatWriteGate,
  withWorkspaceFormatFields,
  workspaceFormatAtLeast,
  workspaceFormatCacheValue,
  workspaceFormatFile,
} from "./workspace-format.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

describe("readWorkspaceFormat", () => {
  it("reads no file as format 0", () => {
    expect(readWorkspaceFormat(null)).toEqual({
      kind: "format",
      format: 0,
      upgrades: "manual",
    })
  })

  it("reads the integer format and ignores comments", () => {
    expect(readWorkspaceFormat("# A comment\nformat: 2\n")).toEqual({
      kind: "format",
      format: 2,
      upgrades: "manual",
    })
  })

  it("reads the file that bootstrap writes as the code format", () => {
    expect(readWorkspaceFormat(workspaceFormatFile().content)).toEqual({
      kind: "format",
      format: CODE_FORMAT,
      upgrades: "manual",
    })
  })

  it("reads the upgrade setting", () => {
    expect(readWorkspaceFormat("format: 2\nupgrades: automatic\n")).toEqual({
      kind: "format",
      format: 2,
      upgrades: "automatic",
    })
  })

  it.each([
    ["an empty file", ""],
    ["a list of applied ids", "format: 3\napplied: [1, 2, 3]\n"],
    ["a text format", 'format: "3"\n'],
    ["an unknown upgrade setting", "format: 3\nupgrades: sometimes\n"],
    ["a fraction", "format: 2.5\n"],
    ["a negative format", "format: -1\n"],
    ["a format larger than an integer column", "format: 3000000000\n"],
    ["YAML that does not parse", "format: [3\n"],
    ["a list", "- 3\n"],
    ["a file larger than 4 KiB", `format: 3\n# ${"x".repeat(5000)}\n`],
  ])("finds %s not valid", (_, text) => {
    expect(readWorkspaceFormat(text).kind).toBe("invalid")
  })

  it("caches an invalid file as the invalid value", () => {
    expect(workspaceFormatCacheValue(readWorkspaceFormat("format: x\n"))).toBe(
      WORKSPACE_FORMAT_INVALID,
    )
    expect(workspaceFormatCacheValue(readWorkspaceFormat(null))).toBe(0)
  })
})

describe("withWorkspaceFormatFields", () => {
  it("sets the upgrade setting and keeps the format and the comment", () => {
    const next = withWorkspaceFormatFields(workspaceFormatFile(2).content, {
      upgrades: "automatic",
    })
    expect(next).toContain("# ctxpipe Workspace format.")
    expect(readWorkspaceFormat(next)).toEqual({
      kind: "format",
      format: 2,
      upgrades: "automatic",
    })
  })

  it("sets a new format and keeps the upgrade setting", () => {
    const next = withWorkspaceFormatFields("format: 2\nupgrades: automatic\n", {
      format: 3,
    })
    expect(readWorkspaceFormat(next)).toEqual({
      kind: "format",
      format: 3,
      upgrades: "automatic",
    })
  })

  it("starts from format 0 when there is no file", () => {
    expect(
      readWorkspaceFormat(
        withWorkspaceFormatFields(null, { upgrades: "automatic" }),
      ),
    ).toEqual({ kind: "format", format: 0, upgrades: "automatic" })
  })

  it("gives null for a file that is not valid", () => {
    expect(
      withWorkspaceFormatFields("format: x\n", { upgrades: "automatic" }),
    ).toBeNull()
  })
})

describe("the format write gate", () => {
  const writable = {
    writeStatus: "writable",
    readOnlyReason: null,
  }

  it.each([
    [null, null],
    [0, null],
    [CODE_FORMAT, null],
    [CODE_FORMAT + 1, WRITE_STATUS_REASONS.formatAhead],
    [WORKSPACE_FORMAT_INVALID, WRITE_STATUS_REASONS.formatInvalid],
  ])("gives format %s the reason %s", (formatVersion, reason) => {
    expect(formatReadOnlyReason(formatVersion)).toBe(reason)
  })

  it("makes a writable Workspace with a newer format read-only", () => {
    expect(
      withFormatWriteGate({ ...writable, formatVersion: CODE_FORMAT + 1 }),
    ).toEqual({
      writeStatus: "read_only",
      readOnlyReason: WRITE_STATUS_REASONS.formatAhead,
      formatVersion: CODE_FORMAT + 1,
    })
  })

  it("keeps the probe result when the format is known to the code", () => {
    const row = { ...writable, formatVersion: CODE_FORMAT }
    expect(withFormatWriteGate(row)).toBe(row)
  })
})

it("keeps the format file host-only", () => {
  expect(isHostOnlyPath(WORKSPACE_FORMAT_PATH)).toBe(true)
})

describe("workspaceFormatAtLeast", () => {
  it.each([
    [null, 2, false],
    [WORKSPACE_FORMAT_INVALID, 0, false],
    [0, 2, false],
    [1, 2, false],
    [2, 2, true],
    [CODE_FORMAT + 1, 2, true],
  ])("reads format %s against %s as %s", (format, min, expected) => {
    expect(workspaceFormatAtLeast(format, min)).toBe(expected)
  })
})
