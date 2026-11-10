import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const pin = JSON.parse(
  readFileSync(join(root, "scripts/ci/visual-container.json"), "utf8"),
)

const checkPin = (change) => {
  const dir = mkdtempSync(join(tmpdir(), "visual-container-"))
  try {
    mkdirSync(join(dir, "scripts/ci"), { recursive: true })
    cpSync(join(root, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"))
    writeFileSync(
      join(dir, "scripts/ci/visual-container.json"),
      JSON.stringify({ ...pin, ...change }),
    )
    return spawnSync(
      process.execPath,
      [join(root, "scripts/ci/check-visual-container.mjs"), dir],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the pinned image has the playwright version of the lockfile", () => {
  const result = checkPin({})
  assert.equal(result.status, 0, result.stderr)
})

test("a tag of another playwright version fails the pin check", () => {
  const result = checkPin({ tag: "v1.0.0-noble" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /lockfile has playwright \d+\.\d+\.\d+/)
})

test("a digest that is not a sha256 digest fails the pin check", () => {
  const result = checkPin({ digest: "latest" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /digest must be a sha256 digest/)
})

// A fake `docker` that logs each call. FAKE_PLATFORM is the server platform,
// FAKE_PRESENT=1 means that the image is already local, FAKE_BROWSERS is the
// listing of /ms-playwright in it.
const playwrightCore = createRequire(
  createRequire(join(root, "apps/ui/package.json")).resolve(
    "playwright/package.json",
  ),
).resolve("playwright-core/package.json")
const revision = JSON.parse(
  readFileSync(join(dirname(playwrightCore), "browsers.json"), "utf8"),
).browsers.find(({ name }) => name === "chromium-headless-shell").revision
const browsers = `chromium-${revision}\nchromium_headless_shell-${revision}\n`

const withDocker = (env, run) => {
  const dir = mkdtempSync(join(tmpdir(), "visual-docker-"))
  try {
    const log = join(dir, "calls")
    writeFileSync(
      join(dir, "docker"),
      `#!${process.execPath}
const [command] = process.argv.slice(2)
require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n")
if (command === "version") process.stdout.write(process.env.FAKE_PLATFORM)
if (command === "image" && process.env.FAKE_PRESENT !== "1") process.exit(1)
if (command === "run") process.stdout.write(process.env.FAKE_BROWSERS)
`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      process.execPath,
      ["scripts/checks/prerequisites.mjs", "visual-container"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: dir,
          FAKE_BROWSERS: browsers,
          ...env,
        },
      },
    )
    run(result, () => readFileSync(log, "utf8"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("visual-container refuses a Docker server that is not linux/arm64", () => {
  withDocker({ FAKE_PLATFORM: "linux/amd64" }, (result) => {
    assert.equal(result.status, 1)
    assert.match(result.stdout, /Docker server is linux\/amd64/)
  })
})

test("visual-container pulls the pinned image when Docker does not have it", () => {
  withDocker({ FAKE_PLATFORM: "linux/arm64" }, (result, calls) => {
    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      calls().includes(
        `pull --platform linux/arm64 ${pin.image}:${pin.tag}@${pin.digest}`,
      ),
    )
  })
})

test("visual-container does not pull an image that Docker has", () => {
  withDocker(
    { FAKE_PLATFORM: "linux/arm64", FAKE_PRESENT: "1" },
    (result, calls) => {
      assert.equal(result.status, 0, result.stderr)
      assert.ok(!calls().includes("pull"))
    },
  )
})

test("visual-container needs Docker to answer", () => {
  withDocker({ FAKE_PLATFORM: "linux/arm64" }, (result, calls) => {
    assert.equal(result.status, 0, result.stderr)
    assert.match(calls(), /^info/m)
  })
})

test("visual-container refuses an image without the browsers of the lockfile", () => {
  withDocker(
    {
      FAKE_PLATFORM: "linux/arm64",
      FAKE_BROWSERS: "chromium_headless_shell-1\n",
    },
    (result) => {
      assert.equal(result.status, 1)
      assert.match(
        result.stdout,
        /digest does not match the playwright version/,
      )
    },
  )
})
