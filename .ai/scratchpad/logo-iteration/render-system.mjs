#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)))

function chromeShot(url, out, { w = 1480, h = 1180 } = {}) {
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
    const killer = setTimeout(() => child.kill("SIGKILL"), 14000)
    child.on("exit", () => {
      clearTimeout(killer)
      resolvePromise()
    })
    child.on("error", reject)
  })
}

const specPath = resolve(process.argv[2])
const out = resolve(process.argv[3])
const spec = JSON.parse(await readFile(specPath, "utf8"))

const cards = spec.items
  .map((item) => {
    const dark = `file://${resolve(root, item.dark)}`
    const light = `file://${resolve(root, item.light)}`
    const icon = `file://${resolve(root, item.icon)}`
    const iconLight = `file://${resolve(root, item.iconLight || item.icon)}`
    const mono = item.mono ? `file://${resolve(root, item.mono)}` : icon
    return `<section class="opt">
      <h2>${item.id}. ${item.name}</h2>
      <p>${item.blurb}</p>
      <div class="pair">
        <div class="stage dark"><img class="lock" src="${dark}" alt="" /></div>
        <div class="stage light"><img class="lock" src="${light}" alt="" /></div>
      </div>
      <div class="icons">
        <div class="ibox dark"><img src="${icon}" style="width:48px;height:48px" alt="" /><span>48</span></div>
        <div class="ibox dark"><img src="${icon}" style="width:32px;height:32px" alt="" /><span>32</span></div>
        <div class="ibox dark"><img src="${icon}" style="width:16px;height:16px" alt="" /><span>16</span></div>
        <div class="ibox light"><img src="${iconLight}" style="width:32px;height:32px" alt="" /><span>light</span></div>
        <div class="ibox dark"><img src="${mono}" style="width:32px;height:32px" alt="" /><span>mono</span></div>
      </div>
    </section>`
  })
  .join("\n")

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #111113; color: #e4e4e7; }
  .page { padding: 24px 28px 36px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #a1a1aa; font-size: 13px; margin: 0 0 18px; }
  .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .opt { border: 1px solid #3f3f46; border-radius: 12px; overflow: hidden; background: #18181b; }
  .opt h2 { margin: 0; padding: 10px 14px 2px; font-size: 15px; }
  .opt p { margin: 0; padding: 0 14px 10px; color: #a1a1aa; font-size: 12px; line-height: 1.4; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; }
  .stage { min-height: 120px; display: grid; place-items: center; padding: 14px; }
  .dark { background: #09090b; }
  .light { background: #f4f4f5; }
  .lock { height: 44px; width: auto; display: block; max-width: 94%; }
  .icons { display: flex; gap: 14px; align-items: flex-end; padding: 10px 14px 14px; background: #09090b; border-top: 1px solid #27272a; }
  .ibox { display: grid; justify-items: center; gap: 4px; padding: 6px; border-radius: 8px; }
  .ibox span { font-size: 10px; color: #71717a; }
  .ibox img { display: block; image-rendering: pixelated; }
</style>
</head>
<body>
  <div class="page">
    <h1>${spec.title}</h1>
    <p class="meta">${spec.meta}</p>
    <div class="opts">${cards}</div>
  </div>
</body>
</html>`

const htmlPath = resolve(dirname(out), `${spec.loop || "system"}.html`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(htmlPath, html)
await chromeShot(`file://${htmlPath}`, out, { w: 1480, h: 1180 })
console.log(out)
