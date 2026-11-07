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
// build (apps/ui/storybook-static). The screenshot is the 1440x900 viewport at
// a pixel ratio of 1, taken after the play ends. Each one is written as
// <out>/<story id>.png, with <out>/capture.json (the status of each story).
//
// Usage: node scripts/ci/visual-capture.mjs --out <dir> <story id>...
// The command needs Docker. It reads the repo read-only, and copies the
// screenshots out of the container, so it works on a laptop VM that mounts
// the home directory read-only.

const root = fileURLToPath(new URL("../../", import.meta.url))

// Runs inside the container: /work is the repo, /out the folder of the PNGs.
async function captureHere(ids, out) {
  mkdirSync(out, { recursive: true })
  const server = await serveStatic(staticDir, 0)
  const stories = []
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
    // The play runner ends a story at the "played" phase, which a story with
    // no play function never reaches (it would wait for 120 seconds).
    const unplayable = ids.filter(
      (id) => !byId.get(id).tags?.includes("play-fn"),
    )
    if (unplayable.length)
      throw new Error(
        `No play function, so the runner cannot tell when the story ends: ${unplayable.join(", ")}`,
      )
    await playStories(
      url,
      ids.map((id) => byId.get(id)),
      (story, { error }) =>
        stories.push({
          id: story.id,
          status: error ? "play-failed" : "captured",
          ...(error ? { error } : {}),
        }),
      false,
      async (page, story, error) => {
        if (!error)
          await page.screenshot({
            path: join(out, `${story.id}.png`),
            type: "png",
            // Ends a finite animation and resets an infinite one (a spinner),
            // so that two runs do not catch different frames.
            animations: "disabled",
          })
      },
    )
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
  writeFileSync(
    join(out, "capture.json"),
    `${JSON.stringify({ stories }, null, 2)}\n`,
  )
  return stories
}

const docker = (args, stdio = "inherit") => {
  const result = spawnSync("docker", args, { stdio, timeout: 1_800_000 })
  if (result.error || result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed (${result.error?.message ?? `exit ${result.status}`}).`,
    )
}

// Captures the stories in the pinned container and copies the PNGs and
// capture.json into `out` (the old PNGs and capture.json of it are removed
// first). Returns the capture.json stories, which hold a play failure too.
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
    docker(["start", "--attach", name])
    docker(["cp", `${name}:/out/.`, out])
  } finally {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
  }
  return JSON.parse(readFileSync(join(out, "capture.json"), "utf8")).stories
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
