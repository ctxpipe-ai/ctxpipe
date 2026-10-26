import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  playStories,
  serveStatic,
  staticDir,
  waitFor,
} from "../ci/storybook-play.mjs"
import { logFile } from "./log.mjs"
import {
  executed,
  lineRanges,
  lineStarts,
  positionsOf,
} from "./trace-lines.mjs"

// The Storybook checks: one for each story with a play function. A story
// with the `workspace-golden` tag is in the lane `golden` (the required CI
// set), and any other story is in the lane `plays`.

const root = fileURLToPath(new URL("../../", import.meta.url))
const ui = join(root, "apps/ui")

// The files that change the result of every story but that a story does not
// import: the Storybook and Vite configs, the static files, the lockfile and
// the runner.
const inputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/ui/package.json",
  "apps/ui/tsconfig.json",
  "apps/ui/vite.config.ts",
  "apps/ui/.storybook/**",
  "apps/ui/public/**",
  "scripts/checks/run.mjs",
  "scripts/checks/storybook.mjs",
  "scripts/ci/storybook-play.mjs",
]

// The check id of a story (an index.json entry). The story id follows the
// file, so a file id stays a prefix of the ids of its stories.
export function storyCheck(story) {
  const file = `apps/ui/${story.importPath.replace(/^\.\//, "")}`
  const lane = (story.tags ?? []).includes("workspace-golden")
    ? "golden"
    : "plays"
  return { id: `storybook:${lane}:${file}#${story.id}`, lane, file }
}

// The `intent` parameter of each story of one file, read with the Storybook
// CSF parser: a string literal in the story's own `parameters` object.
function intents(file, loadCsf) {
  const csf = loadCsf(readFileSync(join(root, file), "utf8"), {
    fileName: file,
    makeTitle: (title) => title ?? file,
  }).parse()
  const found = new Map()
  for (const [name, annotations] of Object.entries(csf._storyAnnotations)) {
    const intent = annotations.parameters?.properties?.find(
      (property) =>
        property.type === "ObjectProperty" &&
        (property.key.name ?? property.key.value) === "intent",
    )?.value
    if (intent?.type === "StringLiteral") found.set(name, intent.value)
  }
  return found
}

export async function listStorybook() {
  const { coreServer, csfTools } = await import(
    "../../apps/ui/.storybook/check-modules.mjs"
  )
  const { buildIndex } = await coreServer()
  const { loadCsf } = await csfTools()
  const index = await buildIndex({ configDir: join(ui, ".storybook") })
  const byFile = new Map()
  return Object.values(index.entries)
    .filter(
      (entry) =>
        entry.type === "story" && (entry.tags ?? []).includes("play-fn"),
    )
    .map((entry) => {
      // buildIndex gives import paths relative to the working directory; the
      // build gives them relative to apps/ui.
      const story = {
        ...entry,
        importPath: `./${relative(ui, resolve(entry.importPath))}`,
      }
      const { id, lane, file } = storyCheck(story)
      if (lane === "golden" && !byFile.has(file))
        byFile.set(file, intents(file, loadCsf))
      const intent = byFile.get(file)?.get(story.exportName)
      return {
        id,
        family: "storybook",
        lane,
        root: "apps/ui",
        file,
        inputs,
        prerequisites: ["storybook-build", "chromium"],
        ...(intent && { intent }),
      }
    })
}

// Maps the browser coverage of each story to repo source lines with the
// source maps of the Storybook build (`sourcemap: "hidden"` in
// .storybook/main.ts writes a `.map` file next to each chunk). Only the
// chunks that Vite built (`/assets/`) hold repo code; the Storybook runtime
// is prebuilt. A built chunk without a map is a gap: the check then has no
// `browser` in `recorded`. A failure here never changes a result.
export function browserTrace(directory) {
  const code = new Map()
  const scripts = new Map()
  let unmapped = 0
  const positionsFor = ({ url, source }) => {
    if (scripts.has(url)) return scripts.get(url)
    let result = { positions: [], mapped: true }
    const { pathname } = new URL(url)
    if (pathname.startsWith("/assets/")) {
      const file = join(directory, decodeURIComponent(pathname))
      const mapFile = `${file}.map`
      if (existsSync(mapFile)) {
        const map = JSON.parse(readFileSync(mapFile, "utf8"))
        result.positions = positionsOf(
          { path: file, text: source, starts: lineStarts(source), map },
          root,
          code,
        )
      } else {
        result = { positions: [], mapped: false }
        unmapped++
      }
    }
    scripts.set(url, result)
    return result
  }
  return {
    // The trace record of one story, or null when the page gave no coverage.
    check(story, durationMs, coverage, mocks) {
      if (!coverage) return null
      try {
        const lines = new Map()
        let complete = true
        for (const entry of coverage) {
          const ranges = entry.functions.flatMap((fn) => fn.ranges)
          if (!ranges.some((range) => range.count > 0)) continue
          const { positions, mapped } = positionsFor(entry)
          if (!mapped) complete = false
          executed(ranges, positions, lines)
        }
        return {
          id: storyCheck(story).id,
          recorded: [
            ...(complete ? ["browser"] : []),
            ...(Array.isArray(mocks) ? ["mocks"] : []),
          ],
          cases: [
            {
              name: story.exportName,
              durationMs,
              lines: lineRanges(lines, code),
              ...(mocks?.length ? { mocks: [...new Set(mocks)].sort() } : {}),
            },
          ],
        }
      } catch (error) {
        process.stderr.write(`No trace for ${story.id}: ${error.message}\n`)
        return null
      }
    },
    report() {
      if (unmapped)
        process.stderr.write(
          `${unmapped} built Storybook chunks have no source map; their stories have no browser lines\n`,
        )
    },
  }
}

// Runs Storybook checks against the static build. With `trace`, it also
// returns the trace records.
export async function runStorybook(checks, trace) {
  const log = logFile("storybook")
  const server = await serveStatic(staticDir, 0)
  const records = []
  const traced = []
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    await waitFor(`${url}/index.json`)
    const index = await (await fetch(`${url}/index.json`)).json()
    const byId = new Map(
      Object.values(index.entries).map((story) => [
        storyCheck(story).id,
        story,
      ]),
    )
    const stories = []
    for (const check of checks) {
      const story = byId.get(check.id)
      if (story) stories.push(story)
      else
        records.push({
          id: check.id,
          status: "error",
          durationMs: 0,
          cases: [],
          log: log.relative,
          message:
            "The story is not in the Storybook build. Rebuild Storybook (unset SKIP_STORYBOOK_BUILD).",
        })
    }
    const tracer = trace ? browserTrace(staticDir) : undefined
    await playStories(
      url,
      stories,
      (story, { error, durationMs, coverage, mocks }) => {
        const { id } = storyCheck(story)
        if (error)
          writeFileSync(log.path, `FAIL ${id}\n${error}\n`, { flag: "a" })
        const status = error ? "failed" : "passed"
        records.push({
          id,
          status,
          durationMs,
          cases: [
            {
              name: story.exportName,
              status,
              durationMs,
              ...(error ? { message: error } : {}),
            },
          ],
          log: log.relative,
        })
        const record = tracer?.check(story, durationMs, coverage, mocks)
        if (record) traced.push(record)
      },
      Boolean(trace),
    )
    tracer?.report()
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
  return { records, traced, traceFailed: false }
}
