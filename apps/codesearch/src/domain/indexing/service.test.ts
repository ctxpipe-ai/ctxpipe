import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { decodeScipIndex, encodeScipIndex } from "../graph/scipProto.js"
import { settleIndexPhases, writeMergedScipIndex } from "./service.js"

describe("settleIndexPhases", () => {
  it("waits for both phases and reports both failures", async () => {
    let rejectScip: (reason: Error) => void = () => {
      throw new Error("SCIP rejection was not initialized")
    }
    const scipPhase = new Promise<void>((_resolve, reject) => {
      rejectScip = reject
    })
    const result = settleIndexPhases(
      Promise.reject(new Error("Zoekt failed")),
      scipPhase,
    )
    let resultSettled = false
    void result.then(
      () => {
        resultSettled = true
      },
      () => {
        resultSettled = true
      },
    )

    await Promise.resolve()
    expect(resultSettled).toBe(false)

    rejectScip(new Error("SCIP failed"))
    await expect(result).rejects.toThrow(
      "Repository indexing failed:\nZoekt: Zoekt failed\nSCIP: SCIP failed",
    )
    expect(resultSettled).toBe(true)
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
