import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
})
