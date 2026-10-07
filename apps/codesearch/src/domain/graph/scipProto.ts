import { open, readFile, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { parse, Reader } from "protobufjs"

export type ScipWireIndex = {
  documents?: object[]
  externalSymbols?: object[]
}

// Wire-compatible subset of the official schema:
// https://github.com/scip-code/scip/blob/main/scip.proto
const scipSchema = parse(`
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
`).root
const scipIndexMessage = scipSchema.lookupType("scip.Index")
const scipDocumentMessage = scipSchema.lookupType("scip.Document")
const scipSymbolMessage = scipSchema.lookupType("scip.SymbolInformation")

export function decodeScipIndex(bytes: Uint8Array): ScipWireIndex {
  return scipIndexMessage.toObject(scipIndexMessage.decode(bytes), {
    arrays: true,
  }) as ScipWireIndex
}

export function encodeScipIndex(index: ScipWireIndex): Uint8Array {
  return scipIndexMessage.encode(scipIndexMessage.fromObject(index)).finish()
}

/**
 * Top-level `Index` fields one at a time: `raw` is the whole field on the
 * wire and `body` a length-delimited field's payload (a `Document` for field
 * 2, an external `SymbolInformation` for 3). Throws on malformed framing.
 */
export function* scipIndexFields(
  bytes: Uint8Array,
): Generator<{ field: number; raw: Uint8Array; body?: Uint8Array }> {
  const reader = Reader.create(bytes)
  while (reader.pos < reader.len) {
    const start = reader.pos
    const tag = reader.uint32()
    const body = (tag & 7) === 2 ? reader.bytes() : undefined
    if (body === undefined) reader.skipType(tag & 7)
    yield { field: tag >>> 3, raw: bytes.subarray(start, reader.pos), body }
  }
}

/** Decode one `Document` (field 2) or external `SymbolInformation` (3). */
export function decodeScipField(field: 2 | 3, body: Uint8Array): object {
  const message = field === 2 ? scipDocumentMessage : scipSymbolMessage
  return message.toObject(message.decode(body), { arrays: true })
}

/**
 * Throws when a SCIP index is malformed, decoding one document at a time so
 * a large shard never becomes one object tree.
 */
export function assertScipIndex(bytes: Uint8Array): void {
  for (const { field, body } of scipIndexFields(bytes)) {
    if (body && (field === 2 || field === 3)) {
      ;(field === 2 ? scipDocumentMessage : scipSymbolMessage).decode(body)
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
 * True when a document path stays inside the checkout: the path text does
 * not climb out, and the real path of an existing file is inside too.
 */
async function documentInsideCheckout(
  checkoutPath: string,
  realCheckoutPath: string,
  relativePath: string,
): Promise<boolean> {
  const inside = (root: string, path: string) =>
    path === root || path.startsWith(`${root}${sep}`)
  const candidate = resolve(checkoutPath, relativePath)
  if (!inside(resolve(checkoutPath), candidate)) return false
  try {
    return inside(realCheckoutPath, await realpath(candidate))
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
  }
}

/**
 * Merge SCIP shard files into `outputPath` one shard at a time without
 * decoding them. Language shards concatenate. With `dedupe` (TypeScript
 * projects, which re-index the projects they reference) the first metadata,
 * document per path, and external symbol per name win. With
 * `checkoutPath`, documents whose path ends outside the checkout are dropped.
 */
export async function mergeScipShardFiles(
  shardPaths: readonly string[],
  outputPath: string,
  options: { dedupe: boolean; checkoutPath?: string },
): Promise<void> {
  const seen = new Set<string>()
  const { checkoutPath } = options
  const realCheckoutPath = checkoutPath ? await realpath(checkoutPath) : ""
  const output = await open(outputPath, "w")
  try {
    for (const shardPath of shardPaths) {
      const bytes = await readFile(shardPath)
      if (bytes.byteLength === 0)
        throw new Error(`Empty SCIP shard: ${shardPath}`)
      const kept: Uint8Array[] = []
      try {
        for (const { field, raw, body } of scipIndexFields(bytes)) {
          if (
            checkoutPath &&
            field === 2 &&
            body &&
            !(await documentInsideCheckout(
              checkoutPath,
              realCheckoutPath,
              firstString(body) ?? "",
            ))
          ) {
            continue
          }
          if (options.dedupe) {
            const key =
              field === 1
                ? "metadata"
                : body && (field === 2 || field === 3)
                  ? `${field}:${firstString(body)}`
                  : null
            if (key !== null && seen.has(key)) continue
            if (key !== null) seen.add(key)
          }
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
