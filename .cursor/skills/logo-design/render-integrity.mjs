#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, parse, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)))
const sheet = resolve(root, "integrity-sheet.html")

function chromeShot(url, out, { w = 1280, h = 1400 } = {}) {
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
        `--user-data-dir=/tmp/ctxpipe-logo-chrome-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        `--window-size=${w},${h}`,
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

const dark = resolve(process.argv[2])
const light = resolve(process.argv[3] ?? dark)
const mark = resolve(process.argv[4] ?? dark)
const out = resolve(process.argv[5] ?? resolve(root, "integrity-out.png"))
const title = process.argv[6] ?? "Integrity sheet"
const mark16 = process.argv[7] ? resolve(process.argv[7]) : mark
const mono = process.argv[8] ? resolve(process.argv[8]) : mark
const word = process.argv[9] ? resolve(process.argv[9]) : dark

mkdirSync(dirname(out), { recursive: true })
const { dir, name, ext } = parse(out)
const q = {
  title,
  dark: `file://${dark}`,
  light: `file://${light}`,
  mark: `file://${mark}`,
  mark16: `file://${mark16}`,
  mono: `file://${mono}`,
  word: `file://${word}`,
}

async function shot(mode, dest, size) {
  const params = new URLSearchParams({ ...q, mode })
  await chromeShot(`file://${sheet}?${params}`, dest, size)
  console.log(dest)
}

await shot("full", out, { w: 1280, h: 1500 })
await shot("compare", resolve(dir, `${name}-compare${ext}`), { w: 1280, h: 640 })
await shot("first-read", resolve(dir, `${name}-first-read${ext}`), { w: 900, h: 420 })
