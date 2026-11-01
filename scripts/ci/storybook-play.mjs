import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Plays Storybook stories in a headless Chromium, one page for each story.
// scripts/ci/storybook-golden.mjs (CI) and the check runner
// (scripts/checks/storybook.mjs) both use it, so a subset run plays a story
// as CI does.

const root = fileURLToPath(new URL("../../", import.meta.url))
const ui = join(root, "apps/ui")
export const staticDir = join(ui, "storybook-static")
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

// Serves the static Storybook build. Port 0 takes a free port; the URL of
// the server is `http://127.0.0.1:${server.address().port}`.
export const serveStatic = async (directory, port) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "")
    const candidates = [
      join(directory, relative),
      join(directory, relative, "index.html"),
    ]
    const file = candidates.find((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    if (!file) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
    })
    response.end(readFileSync(file))
  })
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolveListen)
  })
  return server
}

export const waitFor = async (url) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* retry */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Storybook did not become ready at ${url}`)
}

const playInitScript = () => {
  window.__CTXPIPE_GOLDEN__ = { result: null, waiters: [] }
  // Storybook ends a play in the "errored" phase, with no error event, when the
  // page had an unhandled error during the play. Keep the errors to name them.
  const unhandled = []
  window.addEventListener("unhandledrejection", (event) =>
    unhandled.push(String(event.reason?.stack ?? event.reason)),
  )
  window.addEventListener("error", (event) =>
    unhandled.push(String(event.error?.stack ?? event.message)),
  )
  // The headless browser keeps a real cursor over the page. After a layout
  // change it sends real pointer-move events, which end a hover that a play set
  // with synthetic events. Plays use synthetic events only, so drop real ones.
  for (const type of [
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "mouseover",
    "mouseout",
    "mouseenter",
    "mouseleave",
    "mousemove",
  ])
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) event.stopImmediatePropagation()
      },
      true,
    )
  const record = (result) => {
    if (window.__CTXPIPE_GOLDEN__.result) return
    window.__CTXPIPE_GOLDEN__.result = result
    for (const wait of window.__CTXPIPE_GOLDEN__.waiters) wait(result)
  }
  const hook = () => {
    const channel = globalThis.__STORYBOOK_ADDONS_CHANNEL__
    if (!channel || channel.__ctxpipeGolden) return
    channel.__ctxpipeGolden = true
    const serialize = (error) => {
      if (error && typeof error === "object") {
        return String(error.stack ?? error.message ?? JSON.stringify(error))
      }
      return String(error)
    }
    channel.on("playFunctionThrewException", (error) => {
      record({ ok: false, error: serialize(error) })
    })
    // A render error never reaches the play phase, so it must fail here.
    for (const name of ["storyThrewException", "storyErrored"])
      channel.on(name, (error) => {
        record({ ok: false, error: serialize(error) })
      })
    channel.on("storyRenderPhaseChanged", (info) => {
      const phase = info?.newPhase ?? info?.phase
      if (phase === "played") record({ ok: true, phase })
      // Storybook names the phase before it emits the error of a play that
      // threw. Wait a moment, so that error comes first.
      if (phase === "errored")
        setTimeout(
          () =>
            record({
              ok: false,
              error: `The story ended in the errored phase. Unhandled errors: ${unhandled.join(" | ") || "none seen"}`,
            }),
          50,
        )
    })
  }
  hook()
  setInterval(hook, 20)
}

// Plays each story (an index.json entry) and calls `onStory(story, outcome)`
// after it. `outcome.error` is set when the story failed. With `trace`,
// `outcome.coverage` holds the V8 JS coverage of the page (Playwright
// `page.coverage`), and `outcome.mocks` the headers of the MSW handlers that
// answered a request (null when the page does not expose them). A trace step
// that fails leaves its value undefined and never changes the outcome.
export async function playStories(storybookUrl, stories, onStory, trace) {
  const { chromium } = createRequire(join(ui, "package.json"))("playwright")
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    for (const story of stories) {
      const page = await context.newPage()
      const pageErrors = []
      page.on("pageerror", (error) => pageErrors.push(String(error)))
      await page.addInitScript(playInitScript)
      if ((story.tags ?? []).includes("reduced-motion"))
        await page.emulateMedia({ reducedMotion: "reduce" })
      let covering = false
      if (trace)
        covering = await page.coverage
          .startJSCoverage({ resetOnNavigation: false })
          .then(() => true)
          .catch(() => false)
      const started = performance.now()
      await page.goto(
        `${storybookUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
        { waitUntil: "domcontentloaded", timeout: 120_000 },
      )
      const result = await page
        .waitForFunction(() => window.__CTXPIPE_GOLDEN__?.result, null, {
          timeout: 120_000,
        })
        .then((handle) => handle.jsonValue())
        .catch((error) => ({ ok: false, error: String(error.message) }))
      const durationMs = Math.round(performance.now() - started)
      const error =
        result.ok === false
          ? result.error
          : pageErrors[0]
            ? pageErrors[0]
            : undefined
      let mocks
      let coverage
      if (trace) {
        mocks = await page
          .evaluate(() => window.__ctxpipeMswHandlers?.() ?? null)
          .catch(() => undefined)
        if (covering)
          coverage = await page.coverage.stopJSCoverage().catch(() => undefined)
      }
      await page.close()
      await onStory(story, { error, durationMs, coverage, mocks })
    }
  } finally {
    await browser.close()
  }
}
