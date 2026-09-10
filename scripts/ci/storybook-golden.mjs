import { spawn, spawnSync } from "node:child_process"
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const ui = join(root, "apps/ui")
const staticDir = join(ui, "storybook-static")
const requiredStories = [
  "FirstMessageSendsOnceInStrictMode",
  "LateErrorDoesNotClobberSuccess",
  "SocketCleansUpOnLeave",
  "ReloadReconnects",
  "RapidRouteChanges",
  "EditThenNavigate",
  "OutOfOrderSaves",
  "PierreKeyboardFocus",
  "SharedPublishPending",
  "StableRequestBudget",
  "StableFilesRequestBudget",
]
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

const run = (command, args, cwd = ui, extra = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    ...extra,
  })
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
    run("pnpm", ["--filter", "@ctxpipe/ui", "build-storybook"], root)
    server = await serveStatic(
      staticDir,
      Number(process.env.STORYBOOK_PORT ?? 6007),
    )
  }
  const storybookUrl =
    url ?? `http://127.0.0.1:${process.env.STORYBOOK_PORT ?? 6007}`
  await waitFor(`${storybookUrl}/index.json`)
  const runner = spawn(
    "pnpm",
    [
      "exec",
      "test-storybook",
      "--url",
      storybookUrl,
      "--includeTags",
      "workspace-golden",
      "--json",
      `--outputFile=${report}`,
    ],
    { cwd: ui, stdio: "inherit" },
  )
  const status = await new Promise((resolveStatus, reject) => {
    runner.once("error", reject)
    runner.once("exit", (code, signal) => {
      if (signal) reject(new Error(`test-storybook killed by ${signal}`))
      else resolveStatus(code ?? 1)
    })
  })
  await new Promise((resolveClose) => {
    if (!server) {
      resolveClose()
      return
    }
    server.close(resolveClose)
  })
  const results = JSON.parse(readFileSync(report, "utf8"))
  const titles = (results.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((assertion) => assertion.fullName ?? ""),
  )
  const missing = requiredStories.filter(
    (name) => !titles.some((title) => title.includes(name)),
  )
  if (missing.length) fail(`Missing golden plays: ${missing.join(", ")}`)
  if ((results.numTotalTests ?? 0) !== requiredStories.length)
    fail(
      `Expected ${requiredStories.length} golden plays, executed ${results.numTotalTests}`,
    )
  const inventory = (results.testResults ?? []).map((suite) => {
    try {
      return relative(realpathSync(ui), realpathSync(suite.name)).replaceAll(
        "\\",
        "/",
      )
    } catch {
      return String(suite.name)
    }
  })
  writeFileSync(
    join(output, "inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  )
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
