#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)))
const sheet = resolve(root, "render-sheet.html")

function chromeShot(url, out, { w = 1280, h = 980 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "timeout",
      [
        "12",
        "/usr/bin/google-chrome-stable",
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-first-run",
        `--user-data-dir=/tmp/ctxpipe-logo-chrome-${Date.now()}`,
        `--window-size=${w},${h}`,
        `--screenshot=${out}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    const killer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 12000)
    child.on("exit", () => {
      clearTimeout(killer)
      resolvePromise()
    })
    child.on("error", reject)
  })
}

const src = resolve(process.argv[2] ?? "/workspace/apps/ui/public/ctx_.svg")
const out = resolve(process.argv[3] ?? resolve(root, "renders/current.png"))
const title = process.argv[4] ?? "Current logo — ctx|"
const meta =
  process.argv[5] ??
  "Pixel wordmark + teal pipe. Brand teal #40E0D0. Surfaces: dark app, light, small nav, app icon."

mkdirSync(dirname(out), { recursive: true })
const url = `file://${sheet}?src=${encodeURIComponent(`file://${src}`)}&title=${encodeURIComponent(title)}&meta=${encodeURIComponent(meta)}`
await chromeShot(url, out)
console.log(out)
