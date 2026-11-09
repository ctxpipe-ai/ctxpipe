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
// script, and the compare engine with its tolerance.
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

// The checks of the stories of the Storybook index (without the stories of
// visualSkips). A story has a desktop
// screenshot, and a story with the `page` tag also has a mobile one. A
// screenshot in the unstable list (scripts/ci/visual-unstable-stories.json)
// has no baseline. A story with no other screenshot has no check.
// `ownInputs` are the baselines of the story: only its check reads them.
// The names are those of `baselinePath` in
// packages/visual-review/src/compare/manifest.ts (a test of the manifest
// keeps them equal to the committed baselines).
export function listVisual(entries, unstable) {
  return entries
    .filter((entry) => entry.type === "story")
    .flatMap((story) => {
      const file = `apps/ui/${story.importPath.replace(/^\.\//, "")}`
      const stem = posix.basename(file).replace(/\.stories\.tsx$/, "")
      const ownInputs = (
        (story.tags ?? []).includes("page")
          ? ["desktop", "mobile"]
          : ["desktop"]
      )
        .filter(
          (viewport) =>
            !unstable.some(
              (entry) =>
                entry.id === story.id &&
                (entry.viewport ?? viewport) === viewport,
            ),
        )
        .map((viewport) =>
          posix.join(
            posix.dirname(file),
            "screenshots",
            `${stem}.${story.exportName}.${viewport}.screenshot.png`,
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

// The stories that opt out of screenshots, with their reasons: a story with
// `parameters: { visual: { skip: "<reason>" } }` in its own annotations, or
// in the meta (the default export) of its file. The
// reason must be one string literal; the Storybook CSF parser reads it, so
// the build does not run. An opt-out without a reason is an error. `read`
// gives the text of a story file (from the repository root).
export function visualSkips(
  stories,
  loadCsf,
  read = (file) => readFileSync(join(root, file), "utf8"),
) {
  const skips = new Map()
  const byFile = Map.groupBy(
    stories.filter((story) => story.type === "story"),
    (story) => `apps/ui/${story.importPath.replace(/^\.\//, "")}`,
  )
  const named = (node, key) =>
    node?.properties?.find(
      (property) =>
        property.type === "ObjectProperty" &&
        (property.key.name ?? property.key.value) === key,
    )
  const skipOf = (annotations) =>
    named(named(annotations?.parameters, "visual")?.value, "skip")?.value
  for (const [file, inFile] of byFile) {
    const csf = loadCsf(read(file), {
      fileName: file,
      makeTitle: (title) => title ?? file,
    }).parse()
    for (const story of inFile) {
      // The story's own value wins over the value of its meta.
      const skip =
        skipOf(csf._storyAnnotations[story.exportName]) ??
        skipOf(csf._metaAnnotations)
      if (!skip) continue
      if (skip.type !== "StringLiteral" || !skip.value.trim())
        throw new Error(
          `${file} ${story.exportName}: parameters.visual.skip needs a reason (a string literal).`,
        )
      skips.set(story.id, skip.value)
    }
  }
  return skips
}

// One result record for each story of a `visual:check` result (runVisual):
// passed when each screenshot of the story is unchanged and no baseline of
// it is above the image budget. The message of a failed record gives the
// change of each screenshot and the image folder of the story; the log is
// the manifest. An orphan baseline (status `removed`) is no check.
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
    const cases = entries.map((entry) => {
      const problems = [
        ...(entry.status === "unchanged"
          ? []
          : [
              `${entry.viewport} ${entry.status}${entry.diffPixels ? `: ${entry.diffPixels} pixels differ` : ""}${entry.summary ? `. ${entry.summary.replace(/\.$/, "")}` : ""}`,
            ]),
        ...budget
          .filter((error) => error.path === entry.baseline)
          .map((error) => error.message.replace(/\.$/, "")),
      ]
      return {
        name: entry.viewport,
        status: problems.length ? "failed" : "passed",
        durationMs: Math.round(each / entries.length),
        ...(problems.length && { message: problems.join("; ") }),
      }
    })
    const failed = cases.filter((item) => item.status === "failed")
    return {
      id,
      status: failed.length ? "failed" : "passed",
      durationMs: each,
      cases,
      log: ".ci-results/visual/manifest.json",
      ...(failed.length && {
        message: `${failed.map((item) => item.message).join("; ")}. Images: .ci-results/visual/${storyId}/. If the change is intended, run: pnpm visual:update --only ${storyId}`,
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
