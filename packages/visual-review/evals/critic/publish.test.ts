// The publish step, with a fake GitHub CLI in place of `gh`: it records each
// command and knows the assets of a fake release.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterAll, expect, test } from "vitest"

import { screenshot } from "../../src/compare/fixtures.ts"
import { sha256Of } from "./images.ts"
import { publish } from "./publish.ts"

const folder = mkdtempSync(join(tmpdir(), "bakeoff-publish-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

// Three images: a before and an after image, and the after image of a new
// case.
const bytes = [1, 2, 3].map((n) =>
  screenshot(40, 30, [
    { box: { x: 0, y: 0, width: n * 10, height: 10 }, color: [0, 0, 0] },
  ]),
)
const [before, after, fresh] = bytes.map(sha256Of)
const viewport = { name: "desktop", width: 1440, height: 900 }
const commit = { sha: "a".repeat(40), parent: "b".repeat(40) }
const cases = join(folder, "cases.json")
writeFileSync(
  cases,
  JSON.stringify({
    $schema: "./cases.schema.json",
    version: 1,
    seed: 1,
    until: "c".repeat(40),
    container: "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:0",
    scope: "page",
    cases: [
      {
        id: "intended-1",
        storyId: "a--b",
        viewport,
        diffPixels: 100,
        images: { before, after },
        kind: "intended",
        label: "intended",
        class: null,
        brief: "Change the bar.",
        commit,
        region: null,
      },
      {
        id: "new-1",
        storyId: "a--c",
        viewport,
        diffPixels: null,
        images: { after: fresh },
        kind: "new",
        label: "intended",
        class: null,
        brief: "Add the bar.",
        commit,
        region: null,
      },
    ],
  }),
)
const imagesWith = (edit?: (name: string, data: Uint8Array) => Uint8Array) => {
  const images = mkdtempSync(join(folder, "images-"))
  for (const data of bytes) {
    const name = `${sha256Of(data)}.png`
    writeFileSync(join(images, name), edit ? edit(name, data) : data)
  }
  return images
}

/** A fake `gh`: the release has the assets `assets`, or does not exist. */
const fakeGh = (assets: string[] | null) => {
  const commands: string[][] = []
  const gh = async (args: readonly string[]) => {
    commands.push([...args])
    if (args[1] === "view") {
      if (!assets)
        throw new Error("Command failed: gh release view\nrelease not found")
      return assets.map((name) => `${name}\n`).join("")
    }
    return ""
  }
  return { gh, commands }
}

const publishWith = async (
  images: string,
  gh: ReturnType<typeof fakeGh>["gh"],
) => {
  const printed: string[] = []
  const code = await publish(
    ["--images", images, "--cases", cases],
    (text) => printed.push(text),
    gh,
  )
  return { code, text: printed.join("\n") }
}

test("uploads only the images that the release does not have", async () => {
  const { gh, commands } = fakeGh([`${after}.png`, "other.png"])

  const { code, text } = await publishWith(imagesWith(), gh)

  expect(code).toBe(0)
  const uploads = commands.filter((args) => args[1] === "upload")
  expect(uploads).toHaveLength(1)
  expect(uploads[0]?.slice(0, 5)).toEqual([
    "release",
    "upload",
    "visual-bakeoff-images",
    "--repo",
    "ctxpipe-ai/ctxpipe",
  ])
  expect(
    uploads[0]
      ?.slice(5)
      .map((path) => basename(path))
      .sort(),
  ).toEqual([`${before}.png`, `${fresh}.png`].sort())
  expect(text).toContain("2 images uploaded, 1 already in")
})

test("creates the release as a pre-release on main when it does not exist", async () => {
  const { gh, commands } = fakeGh(null)

  const { code } = await publishWith(imagesWith(), gh)

  expect(code).toBe(0)
  const create = commands.find((args) => args[1] === "create") ?? []
  expect(create).toEqual(
    expect.arrayContaining([
      "visual-bakeoff-images",
      "--target",
      "main",
      "--prerelease",
    ]),
  )
  expect(create.join(" ")).toContain(
    "screenshots of Storybook stories with mock data",
  )
  const uploads = commands.filter((args) => args[1] === "upload")
  expect(uploads[0]?.slice(5)).toHaveLength(3)
})

test("an image with a changed byte stops the publish before an upload", async () => {
  const { gh, commands } = fakeGh([])
  const images = imagesWith((name, data) => {
    if (name !== `${fresh}.png`) return data
    const changed = new Uint8Array(data)
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 1
    return changed
  })

  const { code, text } = await publishWith(images, gh)

  expect(code).toBe(2)
  expect(text).toContain(`${fresh}.png is missing or does not have its SHA-256`)
  expect(commands).toEqual([])
})

test("a missing image stops the publish before an upload", async () => {
  const { gh, commands } = fakeGh([])
  const images = imagesWith()
  rmSync(join(images, `${before}.png`))

  const { code } = await publishWith(images, gh)

  expect(code).toBe(2)
  expect(commands).toEqual([])
})
