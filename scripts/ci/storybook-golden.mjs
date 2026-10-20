import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  selectGoldenStories,
  selectPlayStories,
  shardStories,
} from "./storybook-golden-select.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const ui = join(root, "apps/ui")
const staticDir = join(ui, "storybook-static")
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

const fail = (message) => {
  throw new Error(message)
}

const run = (command, args, cwd = ui) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error || result.signal)
    fail(`${command} did not finish: ${result.error?.message ?? result.signal}`)
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`)
}

const serveStatic = async (directory, port) => {
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

const waitFor = async (url) => {
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
  fail(`Storybook did not become ready at ${url}`)
}

// STORYBOOK_PLAYS=all runs every story that has a play function. The default
// runs the required golden set. STORYBOOK_SHARD=i/n keeps every n-th story.
// STORYBOOK_ONLY=a,b keeps stories whose id or file path contains a, or b.
const mode = process.env.STORYBOOK_PLAYS === "all" ? "all" : "golden"

const chosenStories = (index) => {
  try {
    const stories =
      mode === "all" ? selectPlayStories(index) : selectGoldenStories(index)
    const only = (process.env.STORYBOOK_ONLY ?? "").split(",").filter(Boolean)
    const filtered = only.length
      ? stories.filter((story) =>
          only.some(
            (part) =>
              story.id.includes(part) || story.importPath.includes(part),
          ),
        )
      : stories
    return shardStories(filtered, process.env.STORYBOOK_SHARD)
  } catch (error) {
    fail(error.message)
  }
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
      if (phase === "errored")
        record({
          ok: false,
          error: `The story ended in the errored phase. Unhandled errors: ${unhandled.join(" | ") || "none seen"}`,
        })
    })
  }
  hook()
  setInterval(hook, 20)
}

try {
  run(
    process.execPath,
    [
      join(root, "scripts/ci/check-allowlist-history.mjs"),
      "scripts/ci/failures/storybook-golden.json",
    ],
    root,
  )
  const output = resolve(
    root,
    process.env.CI_TEST_RESULTS_DIR ?? ".ci-results",
    mode === "all" ? "storybook-plays" : "storybook-golden",
  )
  mkdirSync(output, { recursive: true })
  const report = join(output, "results.json")
  rmSync(report, { force: true })
  const url = process.env.STORYBOOK_URL
  let server
  if (!url) {
    if (process.env.SKIP_STORYBOOK_BUILD !== "1")
      run("pnpm", ["--filter", "@ctxpipe/ui", "build-storybook"], root)
    server = await serveStatic(
      staticDir,
      Number(process.env.STORYBOOK_PORT ?? 6007),
    )
  }
  const storybookUrl =
    url ?? `http://127.0.0.1:${process.env.STORYBOOK_PORT ?? 6007}`
  await waitFor(`${storybookUrl}/index.json`)
  const stories = chosenStories(
    await (await fetch(`${storybookUrl}/index.json`)).json(),
  )
  const { chromium } = createRequire(join(ui, "package.json"))("playwright")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const suites = new Map()
  let passed = 0
  let failed = 0
  for (const story of stories) {
    const file = resolve(ui, story.importPath.replace(/^\.\//, ""))
    const suite = suites.get(file) ?? {
      name: file,
      status: "passed",
      assertionResults: [],
    }
    suites.set(file, suite)
    const page = await context.newPage()
    const pageErrors = []
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.addInitScript(playInitScript)
    if ((story.tags ?? []).includes("reduced-motion"))
      await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(
      `${storybookUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
      { waitUntil: "domcontentloaded", timeout: 120_000 },
    )
    const result = await page
      .waitForFunction(() => window.__CTXPIPE_GOLDEN__?.result, null, {
        // The default polling uses requestAnimationFrame. Use a timer, so a
        // page that does not render still reports its result.
        polling: 250,
        timeout: 120_000,
      })
      .then((handle) => handle.jsonValue())
      .catch((error) => ({ ok: false, error: String(error.message) }))
    const error =
      result.ok === false
        ? result.error
        : pageErrors[0]
          ? pageErrors[0]
          : undefined
    await page.close()
    if (error) {
      failed += 1
      suite.status = "failed"
      suite.assertionResults.push({
        status: "failed",
        fullName: story.exportName,
        failureMessages: [error],
      })
      process.stderr.write(`FAIL ${story.exportName}\n${error}\n`)
    } else {
      passed += 1
      suite.assertionResults.push({
        status: "passed",
        fullName: story.exportName,
      })
      process.stdout.write(`PASS ${story.exportName}\n`)
    }
  }
  await browser.close()
  await new Promise((resolveClose) => {
    if (!server) {
      resolveClose()
      return
    }
    server.close(resolveClose)
  })
  const results = {
    numTotalTests: stories.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [...suites.values()],
  }
  writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(
    join(output, "inventory.json"),
    `${JSON.stringify(
      [...suites.keys()].map((file) =>
        relative(ui, file).replaceAll("\\", "/"),
      ),
      null,
      2,
    )}\n`,
  )
  const status = failed ? 1 : 0
  run(
    process.execPath,
    [
      join(root, "scripts/ci/check-test-report.mjs"),
      report,
      join(root, "scripts/ci/failures/storybook-golden.json"),
      String(status),
      join(output, "inventory.json"),
    ],
    ui,
  )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  // The static server and the browser keep the event loop alive, so a plain
  // exit code would hang the job until its timeout.
  process.exit(1)
}
