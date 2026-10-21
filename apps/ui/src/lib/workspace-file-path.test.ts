import { describe, expect, it } from "vitest"
import {
  workspaceFilePath,
  workspaceFilePathFromHref,
} from "./workspace-file-path"

describe("workspaceFilePath", () => {
  it.each([
    ["apps/ui/src/styles.css", "apps/ui/src/styles.css"],
    ["src/routes/[id]/(group)/page.tsx", "src/routes/[id]/(group)/page.tsx"],
    ["./src/main.ts", "src/main.ts"],
    ["package.json", "package.json"],
    ["README.md", "README.md"],
    ["index.js", "index.js"],
    ["  docs/setup.md  ", "docs/setup.md"],
  ])("accepts the repository path %j", (text, path) => {
    expect(workspaceFilePath(text)).toBe(path)
  })

  it.each([
    "",
    "useState",
    "process.env",
    "console.log",
    "Node.js",
    "Next.js",
    "v1.2",
    "1.5/2.0",
    "application/json",
    "@tanstack/react-query",
    "src/components/",
    "pnpm dev",
    "foo bar/a.ts",
    "/etc/hosts",
    "~/notes.md",
    "../outside.ts",
    "src/../secret.ts",
    "https://example.com/a.ts",
    "mailto:someone@example.com",
    "C:\\code\\a.ts",
    "#heading",
    "src/a.ts#L10",
    "src/a.ts:42",
    "src//a.ts",
  ])("rejects %j", (text) => {
    expect(workspaceFilePath(text)).toBeNull()
  })
})

describe("workspaceFilePathFromHref", () => {
  it.each([
    "knowledge/x.md",
    "./knowledge/x.md",
    "knowledge/x.md#L12",
    "knowledge/x.md#L12-L20",
    "knowledge/x.md#heading-anchor-on-a-workspace-file-opens-the-file",
    "knowledge/x.md:12",
    "knowledge/x.md:12:5",
    "file:///workspace/knowledge/x.md",
    "file:///workspace/knowledge/x.md#L58",
    "/workspace/knowledge/x.md",
    "/workspace/knowledge/x.md:12",
  ])("maps %j to the repository path", (href) => {
    expect(workspaceFilePathFromHref(href)).toBe("knowledge/x.md")
  })

  it.each([
    "#section",
    "mailto:a@b.co",
    "/etc/hosts",
    "docs/",
    "../x.md",
  ])("returns null for %j", (href) => {
    expect(workspaceFilePathFromHref(href)).toBeNull()
  })
})
