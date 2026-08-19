import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { decodeScipIndex, encodeScipIndex } from "../graph/scipProto.js"
import {
  publishMergedScipIndex,
  runOptionalIndexPhase,
  writeMergedScipIndex,
} from "./service.js"

describe("runOptionalIndexPhase", () => {
  it("runs Zoekt before SCIP (sequential) and continues after both failures", async () => {
    const order: string[] = []
    let scipStartedBeforeZoektFinished = false

    await runOptionalIndexPhase("codesearch.index.zoekt.failed", async () => {
      order.push("zoekt-start")
      await new Promise((r) => setTimeout(r, 30))
      order.push("zoekt-end")
      throw new Error("Zoekt failed")
    })
    await runOptionalIndexPhase("codesearch.index.scip.failed", async () => {
      if (!order.includes("zoekt-end")) {
        scipStartedBeforeZoektFinished = true
      }
      order.push("scip")
      throw new Error("SCIP failed")
    })

    expect(scipStartedBeforeZoektFinished).toBe(false)
    expect(order).toEqual(["zoekt-start", "zoekt-end", "scip"])
  })
})

describe("writeMergedScipIndex", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-scip-merge-"))
    temporaryDirectories.push(directory)
    return directory
  }

  it("validates and preserves a valid single shard", async () => {
    const directory = await createTemporaryDirectory()
    const shardPath = join(directory, "typescript.scip")
    const outputPath = join(directory, "index.scip")
    const shard = encodeScipIndex({
      documents: [{ relativePath: "src/main.ts" }],
      externalSymbols: [],
    })
    await writeFile(shardPath, shard)

    await writeMergedScipIndex([shardPath], outputPath)

    const output = await readFile(outputPath)
    expect(output).toEqual(Buffer.from(shard))
    expect(decodeScipIndex(output)).toMatchObject({
      documents: [{ relativePath: "src/main.ts" }],
    })
  })

  it("rejects an empty shard without replacing the published index", async () => {
    const directory = await createTemporaryDirectory()
    const shardPath = join(directory, "typescript.scip")
    const outputPath = join(directory, "index.scip")
    const published = encodeScipIndex({
      documents: [{ relativePath: "previous.ts" }],
      externalSymbols: [],
    })
    await writeFile(shardPath, new Uint8Array())
    await writeFile(outputPath, published)

    await expect(writeMergedScipIndex([shardPath], outputPath)).rejects.toThrow(
      `Empty SCIP shard: ${shardPath}`,
    )

    expect(await readFile(outputPath)).toEqual(Buffer.from(published))
    expect(await readdir(directory)).toEqual(["index.scip", "typescript.scip"])
  })

  it("rejects a malformed shard before publishing a multi-shard merge", async () => {
    const directory = await createTemporaryDirectory()
    const validShardPath = join(directory, "typescript.scip")
    const malformedShardPath = join(directory, "go.scip")
    const outputPath = join(directory, "index.scip")
    const published = encodeScipIndex({
      documents: [{ relativePath: "previous.ts" }],
      externalSymbols: [],
    })
    await writeFile(
      validShardPath,
      encodeScipIndex({
        documents: [{ relativePath: "src/main.ts" }],
        externalSymbols: [],
      }),
    )
    await writeFile(malformedShardPath, new Uint8Array([0x12, 0x05, 0x01]))
    await writeFile(outputPath, published)

    await expect(
      writeMergedScipIndex([validShardPath, malformedShardPath], outputPath),
    ).rejects.toThrow(`Malformed SCIP shard ${malformedShardPath}`)

    expect(await readFile(outputPath)).toEqual(Buffer.from(published))
    expect(await readdir(directory)).toEqual([
      "go.scip",
      "index.scip",
      "typescript.scip",
    ])
  })
})

describe("publishMergedScipIndex", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-scip-publish-"))
    temporaryDirectories.push(directory)
    return directory
  }

  it("skips missing and malformed shards and publishes survivors", async () => {
    const directory = await createTemporaryDirectory()
    const validShardPath = join(directory, "typescript.scip")
    const missingShardPath = join(directory, "go.scip")
    const malformedShardPath = join(directory, "python.scip")
    const outputPath = join(directory, "index.scip")
    const shard = encodeScipIndex({
      documents: [{ relativePath: "src/main.ts" }],
      externalSymbols: [],
    })
    await writeFile(validShardPath, shard)
    await writeFile(malformedShardPath, new Uint8Array([0x12, 0x05, 0x01]))

    const published = await publishMergedScipIndex({
      detectedLanguages: ["typescript", "go", "python"],
      shardPaths: [validShardPath, missingShardPath, malformedShardPath],
      outputPath,
    })

    expect(published).toEqual({ shardCount: 1 })
    expect(decodeScipIndex(await readFile(outputPath))).toMatchObject({
      documents: [{ relativePath: "src/main.ts" }],
    })
  })

  it("writes an empty index when no languages were detected", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = join(directory, "index.scip")

    const published = await publishMergedScipIndex({
      detectedLanguages: [],
      shardPaths: [],
      outputPath,
    })

    expect(published).toEqual({ shardCount: 0 })
    expect(decodeScipIndex(await readFile(outputPath))).toMatchObject({
      documents: [],
    })
  })

  it("omits the published index when languages were detected but all shards failed", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = join(directory, "index.scip")
    await writeFile(
      outputPath,
      encodeScipIndex({
        documents: [{ relativePath: "previous.ts" }],
        externalSymbols: [],
      }),
    )

    const published = await publishMergedScipIndex({
      detectedLanguages: ["go"],
      shardPaths: [join(directory, "go.scip")],
      outputPath,
    })

    expect(published).toEqual({ shardCount: 0 })
    expect(existsSync(outputPath)).toBe(false)
  })

  it("deletes empty shards so the next partial ingest retries them", async () => {
    const directory = await createTemporaryDirectory()
    const emptyShardPath = join(directory, "go.scip")
    const outputPath = join(directory, "index.scip")
    await writeFile(emptyShardPath, new Uint8Array())

    await publishMergedScipIndex({
      detectedLanguages: ["go"],
      shardPaths: [emptyShardPath],
      outputPath,
    })

    expect(existsSync(emptyShardPath)).toBe(false)
    expect(existsSync(outputPath)).toBe(false)
  })

  it("deletes malformed shards so the next partial ingest retries them", async () => {
    const directory = await createTemporaryDirectory()
    const malformedShardPath = join(directory, "go.scip")
    const outputPath = join(directory, "index.scip")
    await writeFile(malformedShardPath, new Uint8Array([0x12, 0x05, 0x01]))

    await publishMergedScipIndex({
      detectedLanguages: ["go"],
      shardPaths: [malformedShardPath],
      outputPath,
    })

    expect(existsSync(malformedShardPath)).toBe(false)
    expect(existsSync(outputPath)).toBe(false)
  })
})
