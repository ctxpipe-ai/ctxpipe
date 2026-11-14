import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { fileURLToPath } from "node:url"

import { logFile, logged } from "./log.mjs"

// The visual checks: one for each story that has a screenshot, in the lane
// `visual` of the `storybook` family. A check captures the story in the
// pinned Playwright image and compares each screenshot with its committed
// baseline (scripts/ci/visual.mjs, packages/visual-review/src/compare/).

const root = fileURLToPath(new URL("../../", import.meta.url))

// The files that change every screenshot, but that a story does not import:
// the Storybook and Vite configs, the static files, the lockfile, the
// runner, the image pin, the list of unstable screenshots, the capture
// script with its layout checks, and the compare engine with its tolerance.
const inputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "apps/ui/package.json",
  "apps/ui/tsconfig.json",
  "apps/ui/vite.config.ts",
  "apps/ui/.storybook/**",
  "apps/ui/public/**",
  "apps/ui/src/lib/layout-checks.ts",
  "scripts/checks/run.mjs",
  "scripts/checks/storybook.mjs",
  "scripts/checks/visual.mjs",
  "scripts/ci/storybook-play.mjs",
  "scripts/ci/visual.mjs",
  "scripts/ci/visual-capture.mjs",
  "scripts/ci/visual-container.json",
  "scripts/ci/visual-unstable-stories.json",
  "packages/visual-review/package.json",
  "packages/visual-review/src/story.ts",
  "packages/visual-review/src/compare/**",
]

// The check id of the screenshots of a story (an index.json entry). The
// nightly trace also records each story under this id
// (scripts/ci/storybook-plays.mjs), so that selection maps a changed line to
// the screenshots of the stories that run it.
export function visualCheckId(story) {
  return `storybook:visual:apps/ui/${story.importPath.replace(/^\.\//, "")}#${story.id}`
}

// The checks of the stories of the Storybook index. `options` are the
// screenshot options of each story (visualOptions); a story with `skip` has
// no check. A story has a screenshot at each of its viewports: by default
// desktop, and for a story with the `page` tag also mobile. Each named
// snapshot of its play adds one screenshot at each viewport. A screenshot in
// the unstable list (scripts/ci/visual-unstable-stories.json) has no
// baseline. A story with no other screenshot has no check.
// `ownInputs` are the baselines of the story: only its check reads them.
// The names are those of `baselinePath` in
// packages/visual-review/src/compare/manifest.ts (a test of the manifest
// keeps them equal to the committed baselines).
export function listVisual(entries, unstable, options = new Map()) {
  return entries
    .filter((entry) => entry.type === "story" && !options.get(entry.id)?.skip)
    .flatMap((story) => {
      const file = `apps/ui/${story.importPath.replace(/^\.\//, "")}`
      const stem = posix.basename(file).replace(/\.stories\.tsx$/, "")
      const { viewports, snapshots = [] } = options.get(story.id) ?? {}
      const ownInputs = (
        viewports ??
        ((story.tags ?? []).includes("page")
          ? ["desktop", "mobile"]
          : ["desktop"])
      )
        .filter(
          (viewport) =>
            !unstable.some(
              (entry) =>
                entry.id === story.id &&
                (entry.viewport ?? viewport) === viewport,
            ),
        )
        .flatMap((viewport) =>
          [story.exportName, ...snapshots.map((name) => `${story.exportName}@${name}`)].map(
            (name) =>
              posix.join(
                posix.dirname(file),
                "screenshots",
                `${stem}.${name}.${viewport}.screenshot.png`,
              ),
          ),
        )
      if (!ownInputs.length) return []
      return [
        {
          id: visualCheckId(story),
          family: "storybook",
          lane: "visual",
          root: "apps/ui",
          file,
          inputs,
          ownInputs,
          prerequisites: ["storybook-build", "visual-container"],
          // The pinned image renders the same pixels on each host with the
          // same Docker platform.
          portable: true,
          programs: ["container-platform"],
          // Each check compares with its own baseline: an unselected check
          // keeps a baseline that is not correct.
          selectAll: true,
        },
      ]
    })
}

// The entries of the unstable list. Each one needs a story id, a reason and
// the ticket that fixes it. An entry with a viewport (desktop or mobile) is
// unstable only at that viewport (pnpm visual:check skips only that
// screenshot).
export function readUnstableList(list) {
  for (const entry of list.stories ?? []) {
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !/^CTX-\d+$/.test(entry.ticket ?? "") ||
      ![undefined, "desktop", "mobile"].includes(entry.viewport)
    )
      throw new Error(
        `Each entry of visual-unstable-stories.json needs an id, a reason and a ticket (CTX-<n>), and an optional viewport (desktop or mobile): ${JSON.stringify(entry)}`,
      )
  }
  return list.stories ?? []
}

// The unstable list of the checkout.
export const readUnstable = () =>
  readUnstableList(
    JSON.parse(
      readFileSync(
        join(root, "scripts/ci/visual-unstable-stories.json"),
        "utf8",
      ),
    ),
  )

// The screenshot options of each story, by story id. A story sets them in
// `parameters: { visual: { ... } }`, in its own annotations or in the meta
// (the default export) of its file. The value of the story wins over the value
// of the meta, key by key. The Storybook CSF parser reads them, so each value
// must be a literal and the build does not run:
// - `skip`: a reason (a string). The story has no screenshot.
// - `fullPage`: true takes the full scroll height, not only the viewport.
// - `maxDiffPixels`: the count of pixels that may differ (default 10).
// - `viewports`: the viewports, from "desktop" and "mobile" (default
//   desktop, and mobile too for a story with the `page` tag).
// - `masks`: CSS selectors of content that the capture hides for the shot.
// - `allow`: an object of layout rules (overflow, axes, contrast) that the
//   story accepts, each with its reason (a string). The capture does not run
//   these layout checks (apps/ui/src/lib/layout-checks.ts) for the story.
// Each `snapshot("<name>")` call in the play function of the story (its own,
// or that of the meta) is one named snapshot, in `snapshots`. The name must
// be a string literal in kebab case. An option that is not valid is an error.
// `read` gives the text of a story file (from the repository root).
export function visualOptions(
  stories,
  loadCsf,
  read = (file) => readFileSync(join(root, file), "utf8"),
) {
  const options = new Map()
  const byFile = Map.groupBy(
    stories.filter((story) => story.type === "story"),
    (story) => `apps/ui/${story.importPath.replace(/^\.\//, "")}`,
  )
  for (const [file, inFile] of byFile) {
    const csf = loadCsf(read(file), {
      fileName: file,
      makeTitle: (title) => title ?? file,
    }).parse()
    const meta = parameterOptions(file, "meta", csf._metaAnnotations)
    for (const story of inFile) {
      const annotations = csf._storyAnnotations[story.exportName]
      options.set(story.id, {
        ...meta,
        ...parameterOptions(file, story.exportName, annotations),
        snapshots: snapshotNames(
          `${file} ${story.exportName}`,
          annotations?.play ?? csf._metaAnnotations?.play,
        ),
      })
    }
  }
  return options
}

// The property `key` of an object literal node.
const property = (node, key) =>
  node?.properties?.find(
    (item) =>
      item.type === "ObjectProperty" && (item.key.name ?? item.key.value) === key,
  )

const strings = (node) =>
  node?.type === "ArrayExpression" &&
  node.elements.every((item) => item?.type === "StringLiteral")
    ? node.elements.map((item) => item.value)
    : undefined

// The literal values of `parameters.visual` of one annotations node.
function parameterOptions(file, name, annotations) {
  const visual = property(annotations?.parameters, "visual")?.value
  if (!visual) return {}
  const fail = (problem) => {
    throw new Error(`${file} ${name}: parameters.visual${problem}`)
  }
  if (visual.type !== "ObjectExpression") fail(" must be an object literal.")
  const options = {}
  for (const item of visual.properties) {
    const key = item.key?.name ?? item.key?.value
    const value = item.value
    if (item.type !== "ObjectProperty") fail(" must have literal keys.")
    if (key === "skip") {
      if (value.type !== "StringLiteral" || !value.value.trim())
        fail(".skip needs a reason (a string literal).")
      options.skip = value.value
    } else if (key === "fullPage") {
      if (value.type !== "BooleanLiteral")
        fail(".fullPage must be true or false.")
      options.fullPage = value.value
    } else if (key === "maxDiffPixels") {
      if (value.type !== "NumericLiteral" || !Number.isInteger(value.value))
        fail(".maxDiffPixels must be a whole number literal.")
      options.maxDiffPixels = value.value
    } else if (key === "viewports") {
      const viewports = strings(value)
      if (
        !viewports?.length ||
        new Set(viewports).size !== viewports.length ||
        viewports.some((viewport) => !["desktop", "mobile"].includes(viewport))
      )
        fail(
          '.viewports must be a list of "desktop" and "mobile", each one time.',
        )
      options.viewports = viewports
    } else if (key === "masks") {
      const masks = strings(value)
      if (!masks?.every((mask) => mask.trim()))
        fail(".masks must be a list of CSS selectors (string literals).")
      options.masks = masks
    } else if (key === "allow") {
      if (value.type !== "ObjectExpression") fail(".allow must be an object.")
      options.allow = {}
      for (const rule of value.properties) {
        const name = rule.key?.name ?? rule.key?.value
        if (
          rule.type !== "ObjectProperty" ||
          !["overflow", "axes", "contrast"].includes(name) ||
          rule.value.type !== "StringLiteral" ||
          !rule.value.value.trim()
        )
          fail(
            ".allow needs a layout rule (overflow, axes or contrast) and a reason (a string literal) for each entry.",
          )
        options.allow[name] = rule.value.value
      }
    } else
      fail(
        ` has no option ${JSON.stringify(key)}. The options are skip, fullPage, maxDiffPixels, viewports, masks and allow.`,
      )
  }
  return options
}

// The names of the `snapshot("<name>")` calls in a play function node.
function snapshotNames(story, play) {
  const names = []
  const seen = new Set()
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "snapshot"
    ) {
      const [argument] = node.arguments
      const name = argument?.type === "StringLiteral" ? argument.value : null
      if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw new Error(
          `${story}: snapshot() needs a name in kebab case (a string literal), for example snapshot("menu-open").`,
        )
      if (names.includes(name))
        throw new Error(`${story}: two snapshot("${name}") calls.`)
      names.push(name)
    }
    for (const [key, value] of Object.entries(node))
      if (!["loc", "start", "end", "extra"].includes(key)) walk(value)
  }
  walk(play)
  return names
}

// One result record for each story of a `visual:check` result (runVisual):
// passed when each screenshot of the story is unchanged, has no layout
// problem, and no baseline of it is above the image budget. The message of a
// failed record gives the change and the layout problems of each screenshot
// and the image folder of the story; the log is the manifest. An orphan
// baseline (status `removed`) is no check.
export function visualRecords({ stories, budget }, durationMs) {
  const byCheck = new Map()
  for (const entry of stories) {
    if (entry.status === "removed") continue
    const id = `storybook:visual:${entry.componentFile}#${entry.id}`
    byCheck.set(id, [...(byCheck.get(id) ?? []), entry])
  }
  const each = byCheck.size ? Math.round(durationMs / byCheck.size) : 0
  return [...byCheck].map(([id, entries]) => {
    const storyId = entries[0].id
    // The kinds of problem of the story, for the advice of its message.
    let changed = false
    let misplaced = false
    const cases = entries.map((entry) => {
      // The case of a named snapshot is `<viewport>@<name>`.
      const name = entry.snapshot
        ? `${entry.viewport}@${entry.snapshot}`
        : entry.viewport
      const image = [
        ...(entry.status === "unchanged"
          ? []
          : [
              `${name} ${entry.status}${entry.diffPixels ? `: ${entry.diffPixels} pixels differ` : ""}${entry.summary ? `. ${entry.summary.replace(/\.$/, "")}` : ""}`,
            ]),
        ...budget
          .filter((error) => error.path === entry.baseline)
          .map((error) => error.message.replace(/\.$/, "")),
      ]
      const layout = (entry.layout ?? []).map(
        (problem) =>
          `${name} layout ${problem.rule}: ${problem.element}: ${problem.detail.replace(/\.$/, "")}`,
      )
      const problems = [...image, ...layout]
      changed ||= image.length > 0
      misplaced ||= layout.length > 0
      return {
        name,
        status: problems.length ? "failed" : "passed",
        durationMs: Math.round(each / entries.length),
        ...(problems.length && { message: problems.join("; ") }),
      }
    })
    const failed = cases.filter((item) => item.status === "failed")
    const advice = [
      ...(changed
        ? [
            `Images: .ci-results/visual/${storyId}/. If the change is intended, run: pnpm visual:update --only ${storyId}`,
          ]
        : []),
      ...(misplaced
        ? [
            "Fix the layout, or accept the rule with a reason in parameters.visual.allow (storybook skill, Layout checks)",
          ]
        : []),
    ]
    return {
      id,
      status: failed.length ? "failed" : "passed",
      durationMs: each,
      cases,
      log: ".ci-results/visual/manifest.json",
      ...(failed.length && {
        message: `${failed.map((item) => item.message).join("; ")}. ${advice.join(". ")}`,
      }),
    }
  })
}

// Runs visual checks with one `visual.mjs check --only` of their stories: one
// capture in the pinned container, and one compare with their baselines.
// Its output goes to the log.
export async function runVisualChecks(checks) {
  const log = logFile("storybook-visual")
  const unrun = (id, message) => ({
    id,
    status: "error",
    durationMs: 0,
    cases: [],
    origin: "runner",
    log: log.relative,
    message,
  })
  const index = join(root, "apps/ui/storybook-static/index.json")
  const known = existsSync(index)
    ? new Set(Object.keys(JSON.parse(readFileSync(index, "utf8")).entries))
    : new Set()
  const byStory = new Map(
    checks.map((check) => [check.id.slice(check.id.indexOf("#") + 1), check]),
  )
  const only = [...byStory.keys()].filter((id) => known.has(id))
  const records = [...byStory]
    .filter(([storyId]) => !known.has(storyId))
    .map(([, check]) =>
      unrun(
        check.id,
        "The story is not in the Storybook build. Rebuild Storybook (unset SKIP_STORYBOOK_BUILD).",
      ),
    )
  if (!only.length) return { records }
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-visual-"))
  try {
    logged(
      log.path,
      process.execPath,
      [
        "scripts/ci/visual.mjs",
        "check",
        "--only",
        only.join(","),
        "--records",
        directory,
      ],
      { cwd: root },
    )
    const file = join(directory, "records.ndjson")
    const got = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const { schemaVersion: _version, ...record } = JSON.parse(line)
            return record
          })
      : []
    const ran = new Set(got.map(({ id }) => id))
    records.push(...got)
    for (const storyId of only) {
      const { id } = byStory.get(storyId)
      if (!ran.has(id))
        records.push(
          unrun(
            id,
            `The visual run gave no result for the story. See ${log.relative}.`,
          ),
        )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return { records }
}
