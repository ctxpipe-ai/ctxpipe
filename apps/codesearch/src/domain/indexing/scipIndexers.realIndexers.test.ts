import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

import { decodeScipIndex } from "../graph/scipProto.js"
import type { ScipIndexerId } from "./detectLanguages.js"
import { runScipIndexer } from "./scipIndexers.js"

// These tests run the real scip-clang and scip-ruby of the codesearch image
// (release-assets.txt pins them for amd64 and arm64). The image has the
// platform of the Docker server: linux/arm64 in CI and on Apple silicon. A
// missing build for that platform, or a binary that needs a newer GLIBC than
// the image has, fails here.

type Document = { relativePath: string; symbols?: { symbol: string }[] }

async function indexFixture(
  fixture: string,
  indexerId: ScipIndexerId,
  prepare: (checkoutPath: string) => Promise<void> = async () => {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-real-scip-"))
  try {
    const checkoutPath = join(directory, "checkout")
    await cp(
      fileURLToPath(
        new URL(`../../../test/fixtures/${fixture}/`, import.meta.url),
      ),
      checkoutPath,
      { recursive: true },
    )
    await prepare(checkoutPath)
    const shardPath = join(directory, `${indexerId}.scip`)
    await runScipIndexer({ indexerId, checkoutPath, shardPath })
    const documents = (decodeScipIndex(await readFile(shardPath)).documents ??
      []) as Document[]
    return {
      paths: documents.map((document) => document.relativePath),
      symbols: documents.flatMap((document) =>
        (document.symbols ?? []).map(({ symbol }) => symbol),
      ),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it(
  "indexes a C++ project with the real scip-clang",
  { timeout: 60_000 },
  async () => {
    const { paths, symbols } = await indexFixture(
      "scip-cpp",
      "clang",
      // A compilation database needs absolute paths, so the test writes it
      // for the temporary checkout.
      async (checkoutPath) => {
        const command = (file: string) => ({
          directory: checkoutPath,
          file,
          arguments: ["clang++", "-std=c++17", "-c", file, "-o", "/dev/null"],
        })
        await writeFile(
          join(checkoutPath, "compile_commands.json"),
          JSON.stringify([command("src/greeter.cpp"), command("src/main.cpp")]),
        )
      },
    )
    expect(paths).toEqual(
      expect.arrayContaining(["src/greeter.cpp", "src/main.cpp"]),
    )
    expect(symbols).toContainEqual(
      expect.stringContaining("fixture/Greeter#greet("),
    )
  },
)

it(
  "indexes a Ruby gem with the real scip-ruby",
  { timeout: 60_000 },
  async () => {
    const { paths, symbols } = await indexFixture("scip-ruby", "ruby")
    expect(paths).toEqual(
      expect.arrayContaining(["lib/greeter.rb", "lib/main.rb"]),
    )
    expect(symbols).toContainEqual(
      expect.stringContaining("Fixture#Greeter#greet()."),
    )
  },
)
