import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Plays Storybook stories in a headless Chromium, one page for each story.
// scripts/ci/storybook-plays.mjs (CI) and the check runner
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

// The browser context of every play. The time zone, the locale and the pixel
// ratio are fixed, so that a play gives the same result on each host: a
// Storybook check is portable (scripts/checks/storybook.mjs). The pins also
// make a screenshot of the end state the same on each run
// (scripts/ci/visual-capture.mjs). The story Testing/Play host
// (apps/ui/src/lib/play-host.stories.tsx) proves the pins.
const playContext = {
  viewport: { width: 1440, height: 900 },
  timezoneId: "UTC",
  locale: "en-US",
  deviceScaleFactor: 1,
}

// The origin of every page. The real server has a free port, and a story that
// shows `location.origin` (for example a webhook URL) would show that port.
// The context routes this origin to the real server. A localhost origin keeps
// the page a secure context, which the MSW service worker needs.
const playOrigin = "http://localhost:6006"

// Each page starts its clock at this time, and the clock then runs at the real
// speed. A date in the page is then the same on each run to the minute. The
// init script shifts `Date` only. Playwright's clock (page.clock, also
// setFixedTime) is not used: it runs the timers itself, which changes their
// order against promises and broke a chat story. A clock that stops is not
// used either: code that measures time with Date.now() then never ends (the
// spring scroll of use-stick-to-bottom).
const playTime = Date.parse("2026-11-02T12:00:00Z")

// A story with a play function ends when its play ends. A story without one
// ends when Storybook completes its render. Before a screenshot (`shot`), a
// story with a play also waits for "completed": in that phase Storybook waits
// for the running animations to finish (at most 5 seconds). A story with a
// play must reach "played" first, because a play that did not run also
// reaches "completed".
export const storyEndPhase = (story, shot) =>
  !shot && (story.tags ?? []).includes("play-fn") ? "played" : "completed"

const playInitScript = ({ endPhase, needsPlay, time }) => {
  window.__CTXPIPE_PLAY__ = { result: null, waiters: [] }
  const NativeDate = Date
  const offset = time - NativeDate.now()
  const now = () => NativeDate.now() + offset
  function PinnedDate(...args) {
    if (!new.target) return new NativeDate(now()).toString()
    return Reflect.construct(
      NativeDate,
      args.length ? args : [now()],
      new.target,
    )
  }
  PinnedDate.prototype = NativeDate.prototype
  PinnedDate.now = now
  PinnedDate.parse = NativeDate.parse
  PinnedDate.UTC = NativeDate.UTC
  window.Date = PinnedDate
  // A seeded Math.random (mulberry32), so that a random value is the same on
  // each run.
  let seed = 0x2f6b4a1d
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  // A component can read the CPU count and the memory of the host (for
  // example AnimatedBackground skips its animation on a small device), so
  // every play sees the same small device. No real host reports 3 CPUs and
  // 2 GB, so the Testing/Play host story fails when this override is missing.
  for (const [name, value] of [
    ["hardwareConcurrency", 3],
    ["deviceMemory", 2],
  ])
    Object.defineProperty(Navigator.prototype, name, {
      configurable: true,
      get: () => value,
    })
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
    if (window.__CTXPIPE_PLAY__.result) return
    window.__CTXPIPE_PLAY__.result = result
    for (const wait of window.__CTXPIPE_PLAY__.waiters) wait(result)
  }
  let played = false
  const hook = () => {
    const channel = globalThis.__STORYBOOK_ADDONS_CHANNEL__
    if (!channel || channel.__ctxpipePlay) return
    channel.__ctxpipePlay = true
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
      if (phase === "played") played = true
      if (phase === endPhase && (played || !needsPlay))
        record({ ok: true, phase })
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

// Runs in the page when the story has ended. It stops each CSS animation and
// transition, hides the text caret, waits for the web fonts and places the
// popovers again, so that a screenshot does not depend on its time. A play cannot use this step: some
// plays test an animation. A story can check the settled page with
// `window.__CTXPIPE_PLAY__.afterSettle` (the story Testing/Play host does).
// Returns the error of that check.
const settle = async () => {
  const steady = new CSSStyleSheet()
  steady.replaceSync(
    "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
  )
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, steady]
  await document.fonts.ready
  // A popover that measured its trigger while the trigger still moved (an
  // animation of its menu) is out of place. A resize event makes each
  // popover measure again.
  window.dispatchEvent(new Event("resize"))
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  )
  try {
    await window.__CTXPIPE_PLAY__.afterSettle?.()
  } catch (error) {
    return String(error?.stack ?? error)
  }
}

// Plays each story (an index.json entry) and calls `onStory(story, outcome)`
// after it. `outcome.error` is set when the story failed. With `trace`,
// `outcome.coverage` holds the V8 JS coverage of the page (Playwright
// `page.coverage`), and `outcome.mocks` the headers of the MSW handlers that
// answered a request (null when the page does not expose them). A trace step
// that fails leaves its value undefined and never changes the outcome.
// `afterPlay(page, story, error)` runs once the story has ended and the page
// is settled, before the page closes (a screenshot of the end state, scripts/ci/visual-capture.mjs).
export async function playStories(
  storybookUrl,
  stories,
  onStory,
  trace,
  afterPlay,
) {
  const { chromium } = createRequire(join(ui, "package.json"))("playwright")
  // The browser starts with a time zone and a language that no pin uses, so
  // the Testing/Play host story fails when a pin of playContext is missing.
  const browser = await chromium.launch({
    headless: true,
    env: { ...process.env, TZ: "Pacific/Chatham" },
    // Partial raster draws again only the changed part of a tile. The edge of
    // that part can anti-alias a rounded corner one step lighter or darker
    // than a full draw, so the pixels depend on what changed before the shot.
    args: ["--lang=de-DE", "--disable-partial-raster"],
  })
  try {
    for (const story of stories) {
      // A new context for each story. Thus no story sees the storage of an
      // earlier one, and each page installs the MSW service worker again: a
      // second page in one context makes Chromium update the worker with a
      // request that the route does not see.
      const context = await browser.newContext(playContext)
      // The context, not the page, routes the origin: in Chromium only the
      // context sees the requests of the MSW service worker.
      await context.route(`${playOrigin}/**`, async (route) => {
        const { pathname, search } = new URL(route.request().url())
        // A request can still run when the story ends and its context
        // closes. Then the route fails, and the error must not stop the run.
        await route
          .fetch({ url: `${storybookUrl}${pathname}${search}` })
          .then((response) => route.fulfill({ response }))
          .catch(() => route.abort().catch(() => undefined))
      })
      const page = await context.newPage()
      const pageErrors = []
      page.on("pageerror", (error) => pageErrors.push(String(error)))
      await page.addInitScript(playInitScript, {
        endPhase: storyEndPhase(story, Boolean(afterPlay)),
        needsPlay: (story.tags ?? []).includes("play-fn"),
        time: playTime,
      })
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
        `${playOrigin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
        { waitUntil: "domcontentloaded", timeout: 120_000 },
      )
      const result = await page
        .waitForFunction(() => window.__CTXPIPE_PLAY__?.result, null, {
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
            : await page
                .evaluate(settle)
                .catch((settleError) => String(settleError.message))
      await afterPlay?.(page, story, error)
      let mocks
      let coverage
      if (trace) {
        mocks = await page
          .evaluate(() => window.__ctxpipeMswHandlers?.() ?? null)
          .catch(() => undefined)
        if (covering)
          coverage = await page.coverage.stopJSCoverage().catch(() => undefined)
      }
      await context.close()
      await onStory(story, { error, durationMs, coverage, mocks })
    }
  } finally {
    await browser.close()
  }
}
