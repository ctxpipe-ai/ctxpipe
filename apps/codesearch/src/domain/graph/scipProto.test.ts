import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertScipIndex,
  decodeScipIndex,
  encodeScipIndex,
  mergeScipShardFiles,
} from "./scipProto.js"

describe("SCIP protobuf helpers", () => {
  it("encodes an empty index for repositories without detected languages", () => {
    expect(
      decodeScipIndex(encodeScipIndex({ documents: [], externalSymbols: [] })),
    ).toEqual({ documents: [], externalSymbols: [] })
  })

  it("dedupes shards without decoding, keeping the first document per path and symbol per name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-merge-"))
    const shards = [
      {
        documents: [{ relativePath: "packages/core/a.ts" }],
        externalSymbols: [{ symbol: "npm dep 1.0 Foo#" }],
      },
      {
        documents: [
          { relativePath: "packages/core/a.ts", symbols: [{ symbol: "dup" }] },
          { relativePath: "cmd/main.go" },
        ],
        externalSymbols: [
          { symbol: "npm dep 1.0 Foo#" },
          { symbol: "gomod example.com/pkg Foo#" },
        ],
      },
    ]
    try {
      const shardPaths = await Promise.all(
        shards.map(async (shard, i) => {
          const path = join(directory, `${i}.scip`)
          await writeFile(path, encodeScipIndex(shard))
          return path
        }),
      )
      const outputPath = join(directory, "index.scip")

      await mergeScipShardFiles(shardPaths, outputPath, { dedupe: true })

      expect(decodeScipIndex(await readFile(outputPath))).toEqual({
        documents: [
          { relativePath: "packages/core/a.ts", occurrences: [], symbols: [] },
          { relativePath: "cmd/main.go", occurrences: [], symbols: [] },
        ],
        externalSymbols: [
          expect.objectContaining({ symbol: "npm dep 1.0 Foo#" }),
          expect.objectContaining({ symbol: "gomod example.com/pkg Foo#" }),
        ],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("concatenates language shards when not deduping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-merge-"))
    try {
      const shardPaths = await Promise.all(
        ["go", "typescript"].map(async (language) => {
          const path = join(directory, `${language}.scip`)
          await writeFile(
            path,
            encodeScipIndex({ documents: [{ relativePath: "shared.gen" }] }),
          )
          return path
        }),
      )
      const outputPath = join(directory, "index.scip")

      await mergeScipShardFiles(shardPaths, outputPath, { dedupe: false })

      expect(
        decodeScipIndex(await readFile(outputPath)).documents,
      ).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects an index whose nested document is malformed", () => {
    const valid = encodeScipIndex({ documents: [{ relativePath: "a.ts" }] })
    // A document whose inner relative_path claims 5 bytes but carries 1.
    const malformed = new Uint8Array([0x12, 0x03, 0x0a, 0x05, 0x61])

    expect(() => assertScipIndex(valid)).not.toThrow()
    expect(() => assertScipIndex(malformed)).toThrow()
  })

  it("drops documents whose path ends outside the checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-contained-"))
    try {
      const checkoutPath = join(directory, "checkout")
      const outside = join(directory, "outside")
      await mkdir(join(checkoutPath, "src"), { recursive: true })
      await mkdir(outside)
      await writeFile(join(outside, "data.ts"), "export {}\n")
      await writeFile(join(checkoutPath, "src", "main.ts"), "export {}\n")
      await symlink(outside, join(checkoutPath, "linked"))
      await symlink(join(outside, "data.ts"), join(checkoutPath, "link.ts"))
      const shardPath = join(directory, "0.scip")
      await writeFile(
        shardPath,
        encodeScipIndex({
          documents: [
            { relativePath: "src/main.ts" },
            { relativePath: "/abs/data.ts" },
            { relativePath: "../outside/data.ts" },
            { relativePath: "src/../../outside/data.ts" },
            { relativePath: "linked/data.ts" },
            { relativePath: "link.ts" },
            { relativePath: "src/generated.ts" },
          ],
          externalSymbols: [],
        }),
      )
      const outputPath = join(directory, "index.scip")

      await mergeScipShardFiles([shardPath], outputPath, {
        dedupe: false,
        checkoutPath,
      })

      expect(
        decodeScipIndex(await readFile(outputPath)).documents?.map(
          (document) => (document as { relativePath: string }).relativePath,
        ),
      ).toEqual(["src/main.ts", "src/generated.ts"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("drops documents with a .git segment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scip-git-"))
    try {
      const checkoutPath = join(directory, "checkout")
      await mkdir(join(checkoutPath, ".git"), { recursive: true })
      await writeFile(join(checkoutPath, ".git", "config"), "[core]\n")
      await symlink(".git", join(checkoutPath, "git-dir"))
      const shardPath = join(directory, "0.scip")
      await writeFile(
        shardPath,
        encodeScipIndex({
          documents: [
            { relativePath: "src/main.ts" },
            { relativePath: ".git/config" },
            { relativePath: "sub/.GIT/hook.ts" },
            { relativePath: "git-dir/config" },
          ],
          externalSymbols: [],
        }),
      )
      const outputPath = join(directory, "index.scip")

      await mergeScipShardFiles([shardPath], outputPath, {
        dedupe: false,
        checkoutPath,
      })

      expect(
        decodeScipIndex(await readFile(outputPath)).documents?.map(
          (document) => (document as { relativePath: string }).relativePath,
        ),
      ).toEqual(["src/main.ts"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
