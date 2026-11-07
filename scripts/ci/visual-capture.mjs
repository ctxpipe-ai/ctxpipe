import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { prepare } from "../checks/prerequisites.mjs"
import {
  playStories,
  serveStatic,
  staticDir,
  waitFor,
} from "./storybook-play.mjs"
import pin from "./visual-container.json" with { type: "json" }

// Takes a screenshot of each named story, in the pinned Playwright image
// (scripts/ci/visual-container.json). Mac and Linux render text differently,
// so a laptop and CI both capture in the same image.
//
// It runs the play runner (storybook-play.mjs) against the static Storybook
// build (apps/ui/storybook-static). The runner pins the page (origin, clock,
// Math.random) and settles it after the play (no animation or caret, the web
// fonts loaded). The screenshot is the 1440x900 viewport
// at a pixel ratio of 1, taken after the play ends (or, for a story without a
// play function, after Storybook completes the render). Each one is written as
// <out>/<story id>.png, with <out>/capture.json (the status of each story:
// captured, unstable, play-failed or capture-failed).
//
// Usage: node scripts/ci/visual-capture.mjs --out <dir> <story id>...
// The command needs Docker. It reads the repo read-only, and copies the
// screenshots out of the container, so it works on a laptop VM that mounts
// the home directory read-only.

const root = fileURLToPath(new URL("../../", import.meta.url))

// Takes shots until two shots in a row are the same, and at most `tries`
// shots. A page that still changes after the last shot is not steady; its
// last shot is returned.
export async function shootUntilSteady(shoot, tries) {
  let previous = await shoot()
  for (let shot = 2; shot <= tries; shot++) {
    const png = await shoot()
    if (png.equals(previous)) return { steady: true, png }
    previous = png
  }
  return { steady: false, png: previous }
}

// Runs inside the container: /work is the repo, /out the folder of the PNGs.
async function captureHere(ids, out) {
  mkdirSync(out, { recursive: true })
  const server = await serveStatic(staticDir, 0)
  const stories = []
  const shotErrors = new Map()
  const unsteady = new Set()
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    await waitFor(`${url}/index.json`)
    const index = await (await fetch(`${url}/index.json`)).json()
    const byId = new Map(
      Object.values(index.entries)
        .filter((entry) => entry.type === "story")
        .map((entry) => [entry.id, entry]),
    )
    const unknown = ids.filter((id) => !byId.has(id))
    if (unknown.length)
      throw new Error(`Not in the Storybook build: ${unknown.join(", ")}`)
    await playStories(
      url,
      ids.map((id) => byId.get(id)),
      (story, { error }) => {
        const failure = error ?? shotErrors.get(story.id)
        stories.push({
          id: story.id,
          status: error
            ? "play-failed"
            : failure
              ? "capture-failed"
              : unsteady.has(story.id)
                ? "unstable"
                : "captured",
          ...(failure ? { error: failure } : {}),
        })
      },
      false,
      async (page, story, error) => {
        if (error) return
        try {
          const { steady, png } = await shootUntilSteady(
            () =>
              page.screenshot({
                type: "png",
                // Ends a finite Web Animation and resets an infinite one,
                // which the style sheet of the runner does not stop.
                animations: "disabled",
                caret: "hide",
              }),
            4,
          )
          writeFileSync(join(out, `${story.id}.png`), png)
          if (!steady) unsteady.add(story.id)
        } catch (shotError) {
          shotErrors.set(story.id, String(shotError.message))
        }
      },
    )
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
    // Also after a thrown error, so that the PNGs of the finished stories
    // reach the host.
    writeFileSync(
      join(out, "capture.json"),
      `${JSON.stringify({ stories }, null, 2)}\n`,
    )
  }
}

const docker = (args) => {
  const result = spawnSync("docker", args, {
    stdio: "inherit",
    timeout: 1_800_000,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed (${result.error?.message ?? `exit ${result.status}`}).`,
    )
}

// Captures the stories in the pinned container and copies the PNGs and
// capture.json into `out` (the old PNGs and capture.json of it are removed
// first). Returns one status for each id: captured, unstable, play-failed,
// capture-failed or not-run.
export async function captureInContainer(ids, out) {
  if (!existsSync(join(staticDir, "index.json")))
    throw new Error(
      `${staticDir}/index.json is missing. Run: pnpm --filter @ctxpipe/ui build-storybook`,
    )
  const failed = (await prepare(["visual-container"])).get("visual-container")
  if (failed) throw new Error(failed)
  const name = `ctxpipe-visual-capture-${process.pid}-${Date.now()}`
  mkdirSync(out, { recursive: true })
  for (const file of readdirSync(out))
    if (file.endsWith(".png") || file === "capture.json")
      rmSync(join(out, file))
  try {
    // --init reaps the browser processes and --ipc=host gives Chromium shared
    // memory, as the Playwright documentation advises for the image.
    docker([
      "create",
      "--name",
      name,
      "--platform",
      pin.platform,
      "--init",
      "--ipc=host",
      "--volume",
      `${root}:/work:ro`,
      "--workdir",
      "/work",
      `${pin.image}:${pin.tag}@${pin.digest}`,
      "node",
      "scripts/ci/visual-capture.mjs",
      "--inside",
      ...ids,
    ])
    // A run that throws exits non-zero. Copy its partial results anyway.
    const started = spawnSync("docker", ["start", "--attach", name], {
      stdio: "inherit",
      timeout: 1_800_000,
    })
    docker(["cp", `${name}:/out/.`, out])
    if (started.status !== 0)
      process.stderr.write(
        `The capture container exited with ${started.status}; some stories did not run.\n`,
      )
  } finally {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
  }
  const { stories } = JSON.parse(
    readFileSync(join(out, "capture.json"), "utf8"),
  )
  return ids.map(
    (id) =>
      stories.find((story) => story.id === id) ?? { id, status: "not-run" },
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  // Inside, a play failure is a status in capture.json, not an exit code, so
  // that `docker cp` still gets the PNGs of the other stories.
  if (args[0] === "--inside") await captureHere(args.slice(1), "/out")
  else {
    const flag = args.indexOf("--out")
    const out = flag === -1 ? undefined : args[flag + 1]
    const ids = args.filter((_, i) => i !== flag && i !== flag + 1)
    if (!out || !ids.length) {
      process.stderr.write(
        "Usage: node scripts/ci/visual-capture.mjs --out <dir> <story id>...\n",
      )
      process.exitCode = 1
    } else {
      const stories = await captureInContainer(ids, resolve(out))
      for (const story of stories)
        process.stdout.write(`${story.status} ${story.id}\n`)
      process.exitCode = stories.some((story) => story.status !== "captured")
        ? 1
        : 0
    }
  }
}
