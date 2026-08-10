import { parse } from "protobufjs"

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

export function mergeScipIndexes(
  indexes: readonly ScipWireIndex[],
): Uint8Array {
  return encodeScipIndex({
    documents: indexes.flatMap((index) => index.documents ?? []),
    externalSymbols: indexes.flatMap((index) => index.externalSymbols ?? []),
  })
}
