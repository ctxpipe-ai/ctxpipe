import { describe, expect, it } from "vitest"
import {
  decodeScipIndex,
  encodeScipIndex,
  mergeScipIndexes,
} from "./scipProto.js"

describe("SCIP protobuf helpers", () => {
  it("merges documents and external symbols from language shards", () => {
    const first = decodeScipIndex(
      encodeScipIndex({
        documents: [{ relativePath: "src/main.ts" }],
        externalSymbols: [{ symbol: "npm pkg TypeScript 1.0 Foo#" }],
      }),
    )
    const second = decodeScipIndex(
      encodeScipIndex({
        documents: [{ relativePath: "cmd/main.go" }],
        externalSymbols: [{ symbol: "gomod example.com/pkg Foo#" }],
      }),
    )

    expect(decodeScipIndex(mergeScipIndexes([first, second]))).toMatchObject({
      documents: [
        { relativePath: "src/main.ts" },
        { relativePath: "cmd/main.go" },
      ],
      externalSymbols: [
        { symbol: "npm pkg TypeScript 1.0 Foo#" },
        { symbol: "gomod example.com/pkg Foo#" },
      ],
    })
  })

  it("encodes an empty index for repositories without detected languages", () => {
    expect(
      decodeScipIndex(encodeScipIndex({ documents: [], externalSymbols: [] })),
    ).toEqual({ documents: [], externalSymbols: [] })
  })
})
