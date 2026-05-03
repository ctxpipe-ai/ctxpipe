#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { cwd } from "node:process"
import { fileURLToPath } from "node:url"

const dry = process.env.FORGE_PROVISION_DRY_RUN === "1"
if (dry) {
  process.stdout.write("forge provision dry run\n")
  process.exit(0)
}

const token = process.env.FORGE_API_TOKEN
const site = process.env.CONFLUENCE_SITE
const email = process.env.FORGE_EMAIL?.trim()
const name = process.env.FORGE_APP_NAME ?? "ctxpipe-forge"
const existing = process.env.EXISTING_APP_ID?.trim()
const developerSpaceIdFromArgv = process.argv[2]?.trim()
if (!token || !site || !email) {
  process.stderr.write(
    "Missing FORGE_API_TOKEN, CONFLUENCE_SITE, or FORGE_EMAIL (Atlassian account email for the token)\n",
  )
  process.exit(1)
}

const stdio = "inherit"
// Forge stores settings under $HOME; some worker users have unset HOME — still need writable config dir.
const env = {
  ...process.env,
  FORGE_API_TOKEN: token,
  FORGE_EMAIL: email,
  HOME: cwd(),
}

/** Script lives at apps/backend/src/scripts → backend root two levels up. */
const BACKEND_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** Explicit path avoids PATH shims that break when HOME is overridden (Volta forge stub + isolated HOME cwd). Workers without a workspace install rely on global `forge` on PATH. */
function resolveForgeExecutable() {
  const linked = join(BACKEND_PKG_ROOT, "node_modules", ".bin", "forge")
  if (existsSync(linked)) return linked
  return "forge"
}

function forge(args) {
  execFileSync(resolveForgeExecutable(), args, { stdio, env, cwd: cwd() })
}

try {
  // Containers / OpenWorkflow workers are non‑TTY; Forge otherwise prompts for usage analytics consent
  // and throws "Prompts can not be meaningfully rendered in non-TTY environments".
  forge(["settings", "set", "usage-analytics", "false"])
  if (!existing) {
    const registerArgs = ["register", name]
    if (developerSpaceIdFromArgv) {
      registerArgs.push("-s", developerSpaceIdFromArgv, "-y")
    }
    registerArgs.push("--verbose")
    forge(registerArgs)
  }
  forge(["deploy", "-e", "production", "--non-interactive", "--verbose"])
  const installArgs = [
    "install",
    "-e",
    "production",
    "-s",
    site,
    "-p",
    "Confluence",
    "--non-interactive",
    "--verbose",
  ]
  if (process.env.FORGE_CONFIRM_SCOPES === "1")
    installArgs.push("--confirm-scopes")
  forge(installArgs)
  if (existing) writeFileSync(".forge-appid", existing, "utf8")
  process.stdout.write(`OK ${cwd()}\n`)
} catch (e) {
  process.stderr.write(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
