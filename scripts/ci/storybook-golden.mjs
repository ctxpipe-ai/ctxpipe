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
  requiredStories,
  selectGoldenStories,
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

const goldenStories = (index) => {
  try {
    return selectGoldenStories(index)
  } catch (error) {
    fail(error.message)
  }
}

const playInitScript = () => {
  window.__CTXPIPE_GOLDEN__ = { result: null, waiters: [] }
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
    channel.on("storyRenderPhaseChanged", (info) => {
      const phase = info?.newPhase ?? info?.phase
      if (phase === "played") record({ ok: true, phase })
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
    "storybook-golden",
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
  const stories = goldenStories(
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
    numTotalTests: requiredStories.length,
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
  process.exitCode = 1
}
