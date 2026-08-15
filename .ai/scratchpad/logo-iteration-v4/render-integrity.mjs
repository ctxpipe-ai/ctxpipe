#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const integrity = "/workspace/.cursor/skills/logo-design/render-integrity.mjs"
const args = process.argv.slice(2)
const r = spawnSync("node", [integrity, ...args], { stdio: "inherit" })
process.exit(r.status ?? 1)
