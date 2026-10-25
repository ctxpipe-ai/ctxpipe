import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const cli = fileURLToPath(new URL("./forge-provision-cli.mjs", import.meta.url))
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Runs a copy of the CLI beside a stand-in `forge` binary that writes its
 * arguments to `forge-calls.log` in the app directory.
 */
function runInstall(env: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "forge-cli-test-"))
  dirs.push(root)
  mkdirSync(join(root, "src", "scripts"), { recursive: true })
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
  const script = join(root, "src", "scripts", "forge-provision-cli.mjs")
  copyFileSync(cli, script)
  const forge = join(root, "node_modules", ".bin", "forge")
  writeFileSync(forge, '#!/bin/sh\necho "$*" >> "$PWD/forge-calls.log"\n')
  chmodSync(forge, 0o755)
  const app = join(root, "app")
  mkdirSync(app)
  execFileSync(process.execPath, [script, "install"], {
    cwd: app,
    env: {
      PATH: process.env.PATH,
      FORGE_API_TOKEN: "test-value",
      CONFLUENCE_SITE: "example.atlassian.net",
      FORGE_EMAIL: "operator@example.com",
      ...env,
    },
    stdio: "pipe",
  })
  return readFileSync(join(app, "forge-calls.log"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("install "))
}

describe("forge-provision-cli install", () => {
  const appId = "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43"

  it("installs without --upgrade when the connection has an app ID but no install", () => {
    const [install] = runInstall({ EXISTING_APP_ID: appId })
    expect(install).toBeDefined()
    expect(install).not.toContain("--upgrade")
    expect(install).not.toContain("--confirm-scopes")
  })

  it("upgrades the install when the connection has an installation ID", () => {
    const [install] = runInstall({
      EXISTING_APP_ID: appId,
      EXISTING_INSTALLATION_ID: "ari:cloud:ecosystem::installation/1",
    })
    expect(install).toContain("--upgrade --confirm-scopes")
  })
})
