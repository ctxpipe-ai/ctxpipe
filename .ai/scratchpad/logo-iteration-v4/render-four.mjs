#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)))
const sheet = resolve(root, "four.html")

function chromeShot(url, out) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "timeout",
      [
        "16",
        "/usr/bin/google-chrome-stable",
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-first-run",
        "--virtual-time-budget=8000",
        `--user-data-dir=/tmp/ctxpipe-logo-four-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        "--window-size=1280,980",
        `--screenshot=${out}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    const killer = setTimeout(() => child.kill("SIGKILL"), 18000)
    child.on("exit", () => {
      clearTimeout(killer)
      resolvePromise()
    })
    child.on("error", reject)
  })
}

const title = process.argv[2]
const out = resolve(process.argv[3])
const basisLabel = process.argv[4]
const basisDark = process.argv[5]
const basisLight = process.argv[6]
const pairs = process.argv.slice(7)
mkdirSync(dirname(out), { recursive: true })
const q = new URLSearchParams({
  title,
  basis: basisLabel,
  bd: `file://${resolve(basisDark)}`,
  bl: `file://${resolve(basisLight)}`,
})
for (let i = 0; i < 4; i++) {
  const [name, dark, light] = (pairs[i] ?? "").split("|")
  if (name) q.set("n" + i, name)
  if (dark) q.set("d" + i, `file://${resolve(dark)}`)
  if (light) q.set("l" + i, `file://${resolve(light)}`)
}
await chromeShot(`file://${sheet}?${q}`, out)
console.log(out)
