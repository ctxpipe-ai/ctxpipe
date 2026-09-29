import { open, readFile } from "node:fs/promises"
import { parse, Reader } from "protobufjs"

export type ScipWireIndex = {
  documents?: object[]
  externalSymbols?: object[]
}

// Wire-compatible subset of the official schema:
// https://github.com/scip-code/scip/blob/main/scip.proto
const scipIndexMessage = parse(`
  syntax = "proto3";
  package scip;

  message Index {
    repeated Document documents = 2;
    repeated SymbolInformation external_symbols = 3;
  }

  message Document {
    string relative_path = 1;
    repeated Occurrence occurrences = 2;
    repeated SymbolInformation symbols = 3;
  }

  message SymbolInformation {
    string symbol = 1;
    repeated string documentation = 3;
    repeated Relationship relationships = 4;
    int32 kind = 5;
    string display_name = 6;
    string enclosing_symbol = 8;
  }

  message Relationship {
    string symbol = 1;
    bool is_reference = 2;
    bool is_implementation = 3;
    bool is_type_definition = 4;
    bool is_definition = 5;
  }

  message SingleLineRange {
    int32 line = 1;
    int32 start_character = 2;
    int32 end_character = 3;
  }

  message MultiLineRange {
    int32 start_line = 1;
    int32 start_character = 2;
    int32 end_line = 3;
    int32 end_character = 4;
  }

  message Occurrence {
    repeated int32 range = 1 [packed = true];
    string symbol = 2;
    int32 symbol_roles = 3;
    int32 syntax_kind = 5;
    repeated int32 enclosing_range = 7 [packed = true];
    SingleLineRange single_line_range = 8;
    MultiLineRange multi_line_range = 9;
    SingleLineRange single_line_enclosing_range = 10;
    MultiLineRange multi_line_enclosing_range = 11;
  }
`).root.lookupType("scip.Index")

export function decodeScipIndex(bytes: Uint8Array): ScipWireIndex {
  return scipIndexMessage.toObject(scipIndexMessage.decode(bytes), {
    arrays: true,
  }) as ScipWireIndex
}

export function encodeScipIndex(index: ScipWireIndex): Uint8Array {
  return scipIndexMessage.encode(scipIndexMessage.fromObject(index)).finish()
}

/**
 * Top-level `Index` fields as raw wire slices. Documents and external symbols
 * carry their first string field (`relative_path` / `symbol`) as `key`; their
 * bodies are never decoded. Throws on malformed framing.
 */
export function* scipIndexFields(
  bytes: Uint8Array,
): Generator<{ field: number; key?: string; raw: Uint8Array }> {
  const reader = Reader.create(bytes)
  while (reader.pos < reader.len) {
    const start = reader.pos
    const tag = reader.uint32()
    const field = tag >>> 3
    if ((tag & 7) !== 2) {
      reader.skipType(tag & 7)
      yield { field, raw: bytes.subarray(start, reader.pos) }
      continue
    }
    const body = reader.bytes()
    yield {
      field,
      key: field === 2 || field === 3 ? firstString(body) : undefined,
      raw: bytes.subarray(start, reader.pos),
    }
  }
}

function firstString(message: Uint8Array): string | undefined {
  const reader = Reader.create(message)
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    if (tag === ((1 << 3) | 2)) return reader.string()
    reader.skipType(tag & 7)
  }
  return undefined
}

/**
 * Merge SCIP shard files into `outputPath` one shard at a time without
 * decoding them, keeping the first metadata, the first document per path, and
 * the first external symbol per name: TypeScript projects re-index the
 * projects they reference, so one file can arrive from several shards.
 */
export async function mergeScipShardFiles(
  shardPaths: readonly string[],
  outputPath: string,
): Promise<void> {
  const seen = new Set<string>()
  const output = await open(outputPath, "w")
  try {
    for (const shardPath of shardPaths) {
      const bytes = await readFile(shardPath)
      if (bytes.byteLength === 0)
        throw new Error(`Empty SCIP shard: ${shardPath}`)
      const kept: Uint8Array[] = []
      try {
        for (const { field, key, raw } of scipIndexFields(bytes)) {
          const seenKey =
            field === 1
              ? "metadata"
              : key === undefined
                ? null
                : `${field}:${key}`
          if (seenKey !== null && seen.has(seenKey)) continue
          if (seenKey !== null) seen.add(seenKey)
          kept.push(raw)
        }
      } catch (error) {
        throw new Error(
          `Malformed SCIP shard ${shardPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      await output.write(Buffer.concat(kept))
    }
  } finally {
    await output.close()
  }
}
