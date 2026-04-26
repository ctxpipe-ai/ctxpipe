#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { cwd } from "node:process"

const dry = process.env.FORGE_PROVISION_DRY_RUN === "1"
if (dry) {
  process.stdout.write("forge provision dry run\n")
  process.exit(0)
}

const token = process.env.FORGE_API_TOKEN
const site = process.env.CONFLUENCE_SITE
const name = process.env.FORGE_APP_NAME ?? "ctxpipe-forge"
const existing = process.env.EXISTING_APP_ID?.trim()
if (!token || !site) {
  process.stderr.write("Missing FORGE_API_TOKEN or CONFLUENCE_SITE\n")
  process.exit(1)
}

const stdio = "inherit"
const env = { ...process.env, FORGE_API_TOKEN: token }

function forge(args) {
  execFileSync("forge", args, { stdio, env, cwd: cwd() })
}

try {
  if (!existing) {
    forge(["register", name, "--non-interactive"])
  }
  forge(["deploy", "-e", "production", "--non-interactive"])
  const installArgs = [
    "install",
    "-e",
    "production",
    "-s",
    site,
    "-p",
    "Confluence",
    "--non-interactive",
  ]
  if (process.env.FORGE_CONFIRM_SCOPES === "1") installArgs.push("--confirm-scopes")
  forge(installArgs)
  if (existing) writeFileSync(".forge-appid", existing, "utf8")
  process.stdout.write(`OK ${cwd()}\n`)
} catch (e) {
  process.stderr.write(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
