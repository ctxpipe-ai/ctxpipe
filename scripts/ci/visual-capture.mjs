import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { prepare } from "../checks/prerequisites.mjs"
import { visualOptions } from "../checks/visual.mjs"
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
// fonts loaded). The screenshot is the viewport (`desktop` 1440x900 or
// `mobile` 390x844) at a pixel ratio of 1, taken after the play ends (or, for
// a story without a play function, after Storybook completes the render).
// The options of the story (`parameters.visual`) can change this: `fullPage`
// takes the full scroll height, and `masks` covers more elements than those
// with the `data-visual-mask` attribute. Each `snapshot("<name>")` call of
// the play takes one more screenshot at that point of the play.
// Each one is written as <out>/<story id>.png (<out>/<story id>@<name>.png
// for a named snapshot), with <out>/capture.json (the status of each shot:
// captured, unstable, play-failed or capture-failed).
//
// Usage: node scripts/ci/visual-capture.mjs --out <dir> <story id>...
// (desktop; pnpm visual:check also captures the mobile screenshots)
// The command needs Docker. It reads the repo read-only, and copies the
// screenshots out of the container, so it works on a laptop VM that mounts
// the home directory read-only.

const root = fileURLToPath(new URL("../../", import.meta.url))

// The screenshot sizes. Every story has a desktop screenshot; a page story
// also has a mobile one.
export const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}

// Takes shots until two shots in a row are the same, and at most 6 shots.
// After a shot that differs, it waits for `pause()`, so that a slow change (a
// scroll that eases to its end) can end. A page that still changes after the
// last shot is not steady; its last shot is returned.
export async function shootUntilSteady(shoot, pause) {
  let previous = await shoot()
  for (let shot = 2; shot <= 6; shot++) {
    if (shot > 2) await pause()
    const png = await shoot()
    if (png.equals(previous)) return { steady: true, png }
    previous = png
  }
  return { steady: false, png: previous }
}

// The key of one screenshot of a story: the story id, and `@<name>` for a
// named snapshot. The capture writes it as <out>/<key>.png.
export const shotKey = (id, snapshot) => (snapshot ? `${id}@${snapshot}` : id)

// Takes one screenshot of the page with the options of its story, until two
// shots in a row are the same, and writes it as <out>/<key>.png. Each element
// with the `data-visual-mask` attribute, and each element that a selector of
// `masks` finds, is hidden for the shot (`visibility: hidden`): its place
// shows the background. A box of Playwright's `mask` option is drawn over
// all content, so it also hides a control that is drawn over a masked canvas.
// Returns the status of the shot: captured, unstable or capture-failed.
async function takeShot(page, { fullPage = false, masks = [] }, out, key) {
  try {
    const style = `${["[data-visual-mask]", ...masks].join(", ")} { visibility: hidden !important; }`
    const { steady, png } = await shootUntilSteady(
      () =>
        page.screenshot({
          type: "png",
          fullPage,
          style,
          // Ends a finite Web Animation and resets an infinite one, which
          // the style sheet of the runner does not stop. Before a named
          // snapshot, it also stops the CSS animations and transitions.
          animations: "disabled",
        }),
      () => page.waitForTimeout(250),
    )
    writeFileSync(join(out, `${key}.png`), png)
    return { status: steady ? "captured" : "unstable" }
  } catch (shotError) {
    return { status: "capture-failed", error: String(shotError.message) }
  }
}

// Runs inside the container: /work is the repo, /out the folder of the PNGs.
// `plan` holds the screenshot options of each story
// (`{ id, fullPage, masks, snapshots }`).
async function captureHere(plan, out, viewport) {
  mkdirSync(out, { recursive: true })
  const server = await serveStatic(staticDir, 0)
  const shots = []
  const options = new Map(plan.map((story) => [story.id, story]))
  // The result of each shot of the story that plays now, by key.
  let taken = new Map()
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    await waitFor(`${url}/index.json`)
    const index = await (await fetch(`${url}/index.json`)).json()
    const byId = new Map(
      Object.values(index.entries)
        .filter((entry) => entry.type === "story")
        .map((entry) => [entry.id, entry]),
    )
    const unknown = [...options.keys()].filter((id) => !byId.has(id))
    if (unknown.length)
      throw new Error(`Not in the Storybook build: ${unknown.join(", ")}`)
    await playStories(
      url,
      [...options.keys()].map((id) => byId.get(id)),
      (story, { error }) => {
        const { snapshots = [] } = options.get(story.id)
        for (const snapshot of [undefined, ...snapshots]) {
          const shot = taken.get(shotKey(story.id, snapshot)) ?? {
            status: "play-failed",
            error: `The play did not call snapshot("${snapshot}").`,
          }
          shots.push({
            id: story.id,
            ...(snapshot && { snapshot }),
            // A play that failed fails each shot of the story.
            ...(error ? { status: "play-failed", error } : shot),
          })
        }
        taken = new Map()
      },
      {
        viewport: viewports[viewport],
        // The play calls `snapshot(name)` (apps/ui/src/lib/visual-snapshot.ts) to
        // take a named snapshot. An error here fails the play.
        beforePlay: (page, story) =>
          page.exposeBinding("__ctxpipeSnapshot", async (_source, name) => {
            const { snapshots = [] } = options.get(story.id)
            const key = shotKey(story.id, name)
            if (!snapshots.includes(name))
              throw new Error(
                `snapshot("${name}") is not a string literal in the play function of the story, so the screenshot has no baseline name. Call snapshot() with a literal name in the play of the story itself.`,
              )
            if (taken.has(key))
              throw new Error(`The play called snapshot("${name}") two times.`)
            await page.evaluate(() => document.fonts.ready)
            taken.set(key, await takeShot(page, options.get(story.id), out, key))
          }),
        afterPlay: async (page, story, error) => {
          if (error) return
          taken.set(
            story.id,
            await takeShot(page, options.get(story.id), out, story.id),
          )
        },
      },
    )
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
    // Also after a thrown error, so that the PNGs of the finished stories
    // reach the host.
    writeFileSync(
      join(out, "capture.json"),
      `${JSON.stringify({ shots }, null, 2)}\n`,
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

let containers = 0
// The check of the Docker server and the image, one time for all containers.
let prepared

// Runs a Node script of this repo in the pinned container, and copies the
// /out folder of the container into `out`. The repo is /work, read-only. A
// script that exits non-zero keeps its partial results in `out`. `files`
// maps a path in the container to a host file that is copied there before
// the start (an input that can be larger than the size limit of one
// argument). The bake-off builder (packages/visual-review/evals/critic/build.ts)
// uses it too.
export async function runInContainer(script, args, out, files = {}) {
  prepared ??= prepare(["visual-container"])
  const failed = (await prepared).get("visual-container")
  if (failed) throw new Error(failed)
  const name = `ctxpipe-visual-capture-${process.pid}-${Date.now()}-${(containers += 1)}`
  mkdirSync(out, { recursive: true })
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
      script,
      ...args,
    ])
    for (const [inside, host] of Object.entries(files))
      docker(["cp", host, `${name}:${inside}`])
    // A run that throws exits non-zero. Copy its partial results anyway.
    // The desktop capture of about 900 stories took 25 minutes on a CI
    // runner, so the run may take one hour. The start does not block, so
    // that a caller can run more containers at once.
    const status = await new Promise((resolveStart) => {
      const started = spawn("docker", ["start", "--attach", name], {
        stdio: "inherit",
        timeout: 3_600_000,
      })
      started.on("error", () => resolveStart(null))
      started.on("close", resolveStart)
    })
    docker(["cp", `${name}:/out/.`, out])
    if (status !== 0)
      process.stderr.write(
        status === null
          ? "The capture container did not finish (no start, or the time limit); some stories did not run.\n"
          : `The capture container exited with ${status}; some stories did not run.\n`,
      )
  } finally {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
  }
}

// The capture plan of the stories `ids` of the static Storybook build: the
// screenshot options of each one (visualOptions in scripts/checks/visual.mjs).
export async function capturePlan(ids) {
  const index = JSON.parse(readFileSync(join(staticDir, "index.json"), "utf8"))
  const stories = Object.values(index.entries).filter((entry) =>
    ids.includes(entry.id),
  )
  const options = visualOptions(stories, (await csfTools()).loadCsf)
  return ids.map((id) => ({ ...options.get(id), id }))
}

// The number of capture containers that run at the same time. One container
// uses about 1.5 CPUs on average and more on a large page. A play waits at
// most 1 second for an element (Testing Library), so a container that gets
// too little CPU fails the play of a large page. Thus each container gets 3
// CPUs of the Docker server: the CPUs less 3 for each capture container that
// already runs (another run on the same host), at most one container for
// each story, and at least one. A 4-CPU CI runner thus keeps one container.
export const captureWorkers = ({ cpus, running }, stories) =>
  Math.max(1, Math.min(Math.floor((cpus - 3 * running) / 3), stories))

// The CPUs of the Docker server, and its capture containers that run now.
const dockerLoad = () => {
  const docker = (args) =>
    spawnSync("docker", args, { encoding: "utf8" }).stdout?.trim() ?? ""
  return {
    cpus: Number(docker(["info", "--format", "{{.NCPU}}"])) || 1,
    running: docker([
      "ps",
      "--quiet",
      "--filter",
      "name=ctxpipe-visual-capture-",
    ])
      .split("\n")
      .filter(Boolean).length,
  }
}

// Splits the plan into `workers` parts: part k gets every `workers`-th story
// from the k-th. The stories of one file are next to each other in the plan,
// and often take the same time, so each part gets a share of the slow ones.
export const splitPlan = (plan, workers) =>
  Array.from({ length: workers }, (_, part) =>
    plan.filter((_, position) => position % workers === part),
  )

// Captures the stories of `plan` (`{ id, fullPage, masks, snapshots }` for
// each story) in the pinned container, and copies the PNGs and capture.json
// into `out` (the old PNGs and capture.json of it are removed first).
// Returns one entry for each shot (the end state of each story, and each
// named snapshot): `{ id, snapshot, status, error }`, with the status
// captured, unstable, play-failed, capture-failed or not-run. The PNG of a
// shot is <out>/<shotKey>.png. `viewport` is desktop or mobile.
//
// More than one container captures at the same time (`workers`, by default
// from the free CPUs of Docker, captureWorkers), each one a part of the plan (splitPlan). Each
// container has its own browser with the same pins, and each story has its
// own browser context, so a screenshot does not depend on the part of its
// story: the capture proof (visual-capture-proof.mjs) compares one container
// with the parallel containers.
export async function captureInContainer(
  plan,
  out,
  viewport = "desktop",
  workers = captureWorkers(dockerLoad(), plan.length),
) {
  if (!viewports[viewport]) throw new Error(`Unknown viewport: ${viewport}`)
  if (!existsSync(join(staticDir, "index.json")))
    throw new Error(
      `${staticDir}/index.json is missing. Run: pnpm --filter @ctxpipe/ui build-storybook`,
    )
  mkdirSync(out, { recursive: true })
  for (const file of readdirSync(out))
    if (file.endsWith(".png") || file === "capture.json")
      rmSync(join(out, file))
  const parts = splitPlan(plan, workers).map((part, k) => ({
    part,
    dir: join(out, `worker-${k + 1}`),
  }))
  process.stdout.write(
    `Capture (${viewport}): ${plan.length} stories in ${workers} container${workers === 1 ? "" : "s"}.\n`,
  )
  const shots = []
  try {
    // Each container ends before the merge, also when another one failed.
    const runs = await Promise.allSettled(
      parts.map(async ({ part, dir }) => {
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir)
        // The plan can be larger than the size limit of one argument.
        const planFile = join(dir, "plan.json")
        writeFileSync(planFile, JSON.stringify(part))
        await runInContainer(
          "scripts/ci/visual-capture.mjs",
          ["--inside", viewport, "/plan.json"],
          dir,
          { "/plan.json": planFile },
        )
      }),
    )
    // A part with no capture.json did not run: its shots are not-run.
    for (const { dir } of parts) {
      for (const file of readdirSync(dir))
        if (file.endsWith(".png")) renameSync(join(dir, file), join(out, file))
      if (existsSync(join(dir, "capture.json")))
        shots.push(
          ...JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")).shots,
        )
    }
    const failed = runs.find((run) => run.status === "rejected")
    if (failed) throw failed.reason
  } finally {
    for (const { dir } of parts) rmSync(dir, { recursive: true, force: true })
    writeFileSync(
      join(out, "capture.json"),
      `${JSON.stringify({ shots }, null, 2)}\n`,
    )
  }
  return plan.flatMap(({ id, snapshots = [] }) =>
    [undefined, ...snapshots].map(
      (snapshot) =>
        shots.find(
          (shot) => shot.id === id && shot.snapshot === snapshot,
        ) ?? { id, ...(snapshot && { snapshot }), status: "not-run" },
    ),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  // Inside, a play failure is a status in capture.json, not an exit code, so
  // that `docker cp` still gets the PNGs of the other stories.
  if (args[0] === "--inside")
    await captureHere(
      JSON.parse(readFileSync(args[2], "utf8")),
      "/out",
      args[1],
    )
  else {
    const value = (name) => {
      const flag = args.indexOf(name)
      return flag === -1 ? undefined : args[flag + 1]
    }
    const out = value("--out")
    const ids = args.filter(
      (arg, i) => arg !== "--out" && args[i - 1] !== "--out",
    )
    if (!out || !ids.length) {
      process.stderr.write(
        "Usage: node scripts/ci/visual-capture.mjs --out <dir> <story id>...\n",
      )
      process.exitCode = 1
    } else {
      const shots = await captureInContainer(
        await capturePlan(ids),
        resolve(out),
      )
      for (const shot of shots)
        process.stdout.write(
          `${shot.status} ${shotKey(shot.id, shot.snapshot)}\n`,
        )
      process.exitCode = shots.some((shot) => shot.status !== "captured")
        ? 1
        : 0
    }
  }
}
