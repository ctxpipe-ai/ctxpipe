import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { Reader } from "protobufjs"

export type GraphPrimitiveName =
  | "find_symbol"
  | "get_callers"
  | "get_callees"
  | "get_imports"
  | "get_type_hierarchy"
  | "get_containing_scope"
  | "trace_path"

export type ScipGraphPayload = {
  primitive: GraphPrimitiveName
  scipIndexPath: string
  repoPath: string
  symbol?: string
  filePath?: string
  module?: string
  maxDepth?: number
  limit?: number
  endSymbol?: string
}

export type ScipGraphResult = {
  ok: boolean
  results: Record<string, unknown>[]
  note?: string
  error?: string
}

type WireSingleLineRange = {
  line?: number
  startCharacter?: number
  endCharacter?: number
}

type WireMultiLineRange = {
  startLine?: number
  startCharacter?: number
  endLine?: number
  endCharacter?: number
}

type WireRelationship = {
  symbol?: string
  isReference?: boolean
  isImplementation?: boolean
  isTypeDefinition?: boolean
  isDefinition?: boolean
}

type WireSymbolInformation = {
  symbol?: string
  documentation?: string[]
  relationships?: WireRelationship[]
  kind?: number
  displayName?: string
  enclosingSymbol?: string
}

type SourceRange = {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

type IndexedOccurrence = {
  documentPath: string
  symbol: string
  symbolRoles: number
  syntaxKind: number
  range: SourceRange
  enclosingRange?: SourceRange
}

type IndexedSymbol = {
  symbol: string
  displayName: string
  documentation: string[]
  relationships: Required<WireRelationship>[]
  kind: number
  enclosingSymbol?: string
  documentPath?: string
}

type ScipIndex = {
  occurrences: IndexedOccurrence[]
  definitions: IndexedOccurrence[]
  symbols: Map<string, IndexedSymbol>
}

type CacheEntry = {
  path: string
  index: ScipIndex
  weight: number
}

type LoadIndexResult = { index?: ScipIndex; missing: boolean }

const indexCache = new Map<string, CacheEntry>()
const inFlightIndexLoads = new Map<string, Promise<LoadIndexResult>>()
let indexCacheWeight = 0

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function rangeFromWire(
  legacy: number[] | undefined,
  single: WireSingleLineRange | undefined,
  multi: WireMultiLineRange | undefined,
): SourceRange | undefined {
  if (single) {
    return {
      startLine: single.line ?? 0,
      startCharacter: single.startCharacter ?? 0,
      endLine: single.line ?? 0,
      endCharacter: single.endCharacter ?? 0,
    }
  }
  if (multi) {
    return {
      startLine: multi.startLine ?? 0,
      startCharacter: multi.startCharacter ?? 0,
      endLine: multi.endLine ?? 0,
      endCharacter: multi.endCharacter ?? 0,
    }
  }
  if (legacy?.length === 3) {
    return {
      startLine: legacy[0] ?? 0,
      startCharacter: legacy[1] ?? 0,
      endLine: legacy[0] ?? 0,
      endCharacter: legacy[2] ?? 0,
    }
  }
  if (legacy?.length === 4) {
    return {
      startLine: legacy[0] ?? 0,
      startCharacter: legacy[1] ?? 0,
      endLine: legacy[2] ?? 0,
      endCharacter: legacy[3] ?? 0,
    }
  }
  return undefined
}

const LENGTH_DELIMITED = 2

/** Packed (`[packed = true]`) or unpacked repeated int32 at the reader. */
function readInt32s(reader: Reader, wireType: number, into: number[]): void {
  if (wireType !== LENGTH_DELIMITED) {
    into.push(reader.int32())
    return
  }
  const end = reader.uint32() + reader.pos
  while (reader.pos < end) into.push(reader.int32())
}

function readSingleLineRange(reader: Reader): WireSingleLineRange {
  const end = reader.uint32() + reader.pos
  const range: WireSingleLineRange = {}
  while (reader.pos < end) {
    const tag = reader.uint32()
    const field = tag >>> 3
    if (field === 1) range.line = reader.int32()
    else if (field === 2) range.startCharacter = reader.int32()
    else if (field === 3) range.endCharacter = reader.int32()
    else reader.skipType(tag & 7)
  }
  return range
}

function readMultiLineRange(reader: Reader): WireMultiLineRange {
  const end = reader.uint32() + reader.pos
  const range: WireMultiLineRange = {}
  while (reader.pos < end) {
    const tag = reader.uint32()
    const field = tag >>> 3
    if (field === 1) range.startLine = reader.int32()
    else if (field === 2) range.startCharacter = reader.int32()
    else if (field === 3) range.endLine = reader.int32()
    else if (field === 4) range.endCharacter = reader.int32()
    else reader.skipType(tag & 7)
  }
  return range
}

function readRelationship(
  reader: Reader,
  intern: (value: string) => string,
): WireRelationship {
  const end = reader.uint32() + reader.pos
  const relationship: WireRelationship = {}
  while (reader.pos < end) {
    const tag = reader.uint32()
    const field = tag >>> 3
    if (field === 1) relationship.symbol = intern(reader.string())
    else if (field === 2) relationship.isReference = reader.bool()
    else if (field === 3) relationship.isImplementation = reader.bool()
    else if (field === 4) relationship.isTypeDefinition = reader.bool()
    else if (field === 5) relationship.isDefinition = reader.bool()
    else reader.skipType(tag & 7)
  }
  return relationship
}

function readSymbolInformation(
  reader: Reader,
  intern: (value: string) => string,
): WireSymbolInformation {
  const end = reader.uint32() + reader.pos
  const info: WireSymbolInformation = { documentation: [], relationships: [] }
  while (reader.pos < end) {
    const tag = reader.uint32()
    const field = tag >>> 3
    if (field === 1) info.symbol = intern(reader.string())
    else if (field === 3) info.documentation?.push(reader.string())
    else if (field === 4)
      info.relationships?.push(readRelationship(reader, intern))
    else if (field === 5) info.kind = reader.int32()
    else if (field === 6) info.displayName = reader.string()
    else if (field === 8) info.enclosingSymbol = intern(reader.string())
    else reader.skipType(tag & 7)
  }
  return info
}

/**
 * Decode straight from the wire into the query index, one field at a time.
 * The protobufjs object tree for a large monorepo (n8n: 1.7M occurrences)
 * cost more than the index itself, and every occurrence held its own copy of
 * its symbol string; symbols and paths are interned instead.
 */
function decodeIndex(bytes: Uint8Array): ScipIndex {
  const occurrences: IndexedOccurrence[] = []
  const definitions: IndexedOccurrence[] = []
  const symbols = new Map<string, IndexedSymbol>()
  const strings = new Map<string, string>()
  const intern = (value: string): string => {
    const existing = strings.get(value)
    if (existing !== undefined) return existing
    strings.set(value, value)
    return value
  }

  const addSymbol = (
    raw: WireSymbolInformation,
    documentPath?: string,
  ): void => {
    if (!raw.symbol) return
    const existing = symbols.get(raw.symbol)
    const relationships =
      raw.relationships && raw.relationships.length > 0
        ? raw.relationships
        : (existing?.relationships ?? [])
    symbols.set(raw.symbol, {
      symbol: raw.symbol,
      displayName:
        raw.displayName || existing?.displayName || symbolName(raw.symbol),
      documentation:
        raw.documentation && raw.documentation.length > 0
          ? raw.documentation
          : (existing?.documentation ?? []),
      relationships: relationships.map((relationship) => ({
        symbol: relationship.symbol ?? "",
        isReference: relationship.isReference ?? false,
        isImplementation: relationship.isImplementation ?? false,
        isTypeDefinition: relationship.isTypeDefinition ?? false,
        isDefinition: relationship.isDefinition ?? false,
      })),
      kind: raw.kind ?? existing?.kind ?? 0,
      enclosingSymbol: raw.enclosingSymbol || existing?.enclosingSymbol,
      documentPath: documentPath ?? existing?.documentPath,
    })
  }

  const readOccurrence = (reader: Reader, documentPath: string): void => {
    const end = reader.uint32() + reader.pos
    const range: number[] = []
    const enclosing: number[] = []
    let symbol = ""
    let symbolRoles = 0
    let syntaxKind = 0
    let single: WireSingleLineRange | undefined
    let multi: WireMultiLineRange | undefined
    let singleEnclosing: WireSingleLineRange | undefined
    let multiEnclosing: WireMultiLineRange | undefined
    while (reader.pos < end) {
      const tag = reader.uint32()
      const field = tag >>> 3
      if (field === 1) readInt32s(reader, tag & 7, range)
      else if (field === 2) symbol = intern(reader.string())
      else if (field === 3) symbolRoles = reader.int32()
      else if (field === 5) syntaxKind = reader.int32()
      else if (field === 7) readInt32s(reader, tag & 7, enclosing)
      else if (field === 8) single = readSingleLineRange(reader)
      else if (field === 9) multi = readMultiLineRange(reader)
      else if (field === 10) singleEnclosing = readSingleLineRange(reader)
      else if (field === 11) multiEnclosing = readMultiLineRange(reader)
      else reader.skipType(tag & 7)
    }
    const occurrenceRange = rangeFromWire(range, single, multi)
    if (!symbol || !occurrenceRange) return
    const occurrence: IndexedOccurrence = {
      documentPath,
      symbol,
      symbolRoles,
      syntaxKind,
      range: occurrenceRange,
      enclosingRange: rangeFromWire(enclosing, singleEnclosing, multiEnclosing),
    }
    occurrences.push(occurrence)
    if ((symbolRoles & 1) !== 0) definitions.push(occurrence)
  }

  // Path first: a document's fields may arrive in any order.
  const readDocument = (reader: Reader): void => {
    const end = reader.uint32() + reader.pos
    const start = reader.pos
    let documentPath = ""
    while (reader.pos < end) {
      const tag = reader.uint32()
      if (tag >>> 3 === 1) documentPath = intern(reader.string())
      else reader.skipType(tag & 7)
    }
    if (!documentPath) return
    reader.pos = start
    while (reader.pos < end) {
      const tag = reader.uint32()
      const field = tag >>> 3
      if (field === 2) readOccurrence(reader, documentPath)
      else if (field === 3)
        addSymbol(readSymbolInformation(reader, intern), documentPath)
      else reader.skipType(tag & 7)
    }
  }

  // External symbols first, as before, so document symbols take precedence.
  for (const pass of [3, 2]) {
    const reader = Reader.create(bytes)
    while (reader.pos < reader.len) {
      const tag = reader.uint32()
      const field = tag >>> 3
      if (field === pass && field === 3)
        addSymbol(readSymbolInformation(reader, intern))
      else if (field === pass && field === 2) readDocument(reader)
      else reader.skipType(tag & 7)
    }
  }

  return { occurrences, definitions, symbols }
}

async function loadIndex(path: string): Promise<LoadIndexResult> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { missing: true }
    }
    throw error
  }

  const cacheKey = `${path}\0${stats.mtimeMs}`
  const cached = indexCache.get(cacheKey)
  if (cached) {
    indexCache.delete(cacheKey)
    indexCache.set(cacheKey, cached)
    return { index: cached.index, missing: false }
  }

  const inFlight = inFlightIndexLoads.get(cacheKey)
  if (inFlight) return inFlight

  const load = (async (): Promise<LoadIndexResult> => {
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { missing: true }
      }
      throw error
    }
    const index = decodeIndex(bytes)

    for (const [key, entry] of indexCache) {
      if (entry.path !== path) continue
      indexCache.delete(key)
      indexCacheWeight -= entry.weight
    }
    indexCache.set(cacheKey, { path, index, weight: stats.size })
    indexCacheWeight += stats.size
    while (indexCache.size > 8 || indexCacheWeight > 256 * 1024 * 1024) {
      const oldestKey = indexCache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = indexCache.get(oldestKey)
      indexCache.delete(oldestKey)
      indexCacheWeight -= oldest?.weight ?? 0
    }

    return { index, missing: false }
  })()
  inFlightIndexLoads.set(cacheKey, load)
  try {
    return await load
  } finally {
    inFlightIndexLoads.delete(cacheKey)
  }
}

function symbolName(symbol: string): string {
  if (symbol.startsWith("local ")) return symbol
  const descriptors = symbol.split(/[/#.:!]/).filter(Boolean)
  const tail = descriptors.at(-1) ?? symbol
  return tail
    .replace(/\([^)]*\)$/u, "")
    .replace(/^`|`$/gu, "")
    .trim()
}

function displayName(index: ScipIndex, symbol: string): string {
  return index.symbols.get(symbol)?.displayName || symbolName(symbol)
}

function kindName(kind: number): string {
  return (
    {
      7: "class",
      9: "constructor",
      11: "enum",
      17: "function",
      21: "interface",
      25: "macro",
      26: "method",
      29: "module",
      30: "namespace",
      42: "protocol",
      49: "struct",
      53: "trait",
      54: "type",
      55: "type_alias",
      61: "variable",
    }[kind] ?? "unknown"
  )
}

function matchesSymbol(
  index: ScipIndex,
  symbol: string,
  anchor: string,
  partial = false,
): boolean {
  const normalizedAnchor = anchor.toLocaleLowerCase()
  const normalizedSymbol = symbol.toLocaleLowerCase()
  const normalizedDisplay = displayName(index, symbol).toLocaleLowerCase()
  if (
    normalizedSymbol === normalizedAnchor ||
    normalizedDisplay === normalizedAnchor
  ) {
    return true
  }
  if (partial) {
    return (
      normalizedDisplay.includes(normalizedAnchor) ||
      symbolName(symbol).toLocaleLowerCase().includes(normalizedAnchor)
    )
  }
  return normalizedSymbol
    .split(/[/#.:!()[\]\s]/u)
    .filter(Boolean)
    .includes(normalizedAnchor)
}

function matchesModule(
  index: ScipIndex,
  symbol: string,
  module: string,
): boolean {
  const normalizedModule = module.toLocaleLowerCase()
  return (
    symbol.toLocaleLowerCase().includes(normalizedModule) ||
    displayName(index, symbol).toLocaleLowerCase().includes(normalizedModule)
  )
}

function fileMatches(
  repoPath: string,
  documentPath: string,
  filePath?: string,
): boolean {
  if (!filePath) return true
  return resolve(repoPath, documentPath) === resolve(repoPath, filePath)
}

function positionCompare(
  lineA: number,
  characterA: number,
  lineB: number,
  characterB: number,
): number {
  return lineA === lineB ? characterA - characterB : lineA - lineB
}

function containsRange(container: SourceRange, nested: SourceRange): boolean {
  return (
    positionCompare(
      container.startLine,
      container.startCharacter,
      nested.startLine,
      nested.startCharacter,
    ) <= 0 &&
    positionCompare(
      container.endLine,
      container.endCharacter,
      nested.endLine,
      nested.endCharacter,
    ) >= 0
  )
}

function rangeSpan(range: SourceRange): number {
  return (
    (range.endLine - range.startLine) * 1_000_000 +
    range.endCharacter -
    range.startCharacter
  )
}

function definitionScope(definition: IndexedOccurrence): SourceRange {
  return definition.enclosingRange ?? definition.range
}

function rangeResult(range: SourceRange): Record<string, number> {
  return {
    start_line: range.startLine,
    start_character: range.startCharacter,
    end_line: range.endLine,
    end_character: range.endCharacter,
  }
}

function isCallable(index: ScipIndex, occurrence: IndexedOccurrence): boolean {
  const kind = index.symbols.get(occurrence.symbol)?.kind ?? 0
  return (
    new Set([9, 17, 25, 26, 34, 43, 45, 47, 50, 51, 68, 69, 70, 71, 80]).has(
      kind,
    ) ||
    occurrence.syntaxKind === 15 ||
    occurrence.syntaxKind === 17 ||
    /\(\)\.?$/u.test(occurrence.symbol)
  )
}

function findDefinitions(
  index: ScipIndex,
  repoPath: string,
  anchor: string,
  filePath?: string,
): IndexedOccurrence[] {
  return index.definitions.filter(
    (definition) =>
      fileMatches(repoPath, definition.documentPath, filePath) &&
      matchesSymbol(index, definition.symbol, anchor),
  )
}

function findEnclosingDefinition(
  index: ScipIndex,
  occurrence: IndexedOccurrence,
  excludeSymbol?: string,
  callableOnly = false,
): IndexedOccurrence | undefined {
  return index.definitions
    .filter(
      (definition) =>
        definition.documentPath === occurrence.documentPath &&
        definition.symbol !== excludeSymbol &&
        (!callableOnly || isCallable(index, definition)) &&
        containsRange(definitionScope(definition), occurrence.range),
    )
    .sort(
      (left, right) =>
        rangeSpan(definitionScope(left)) - rangeSpan(definitionScope(right)),
    )[0]
}

function symbolResult(
  index: ScipIndex,
  repoPath: string,
  symbol: string,
  occurrence?: IndexedOccurrence,
): Record<string, unknown> {
  const info = index.symbols.get(symbol)
  return {
    symbol,
    symbol_name: displayName(index, symbol),
    kind: kindName(info?.kind ?? 0),
    ...(occurrence
      ? {
          file_path: resolve(repoPath, occurrence.documentPath),
          range: rangeResult(occurrence.range),
        }
      : info?.documentPath
        ? { file_path: resolve(repoPath, info.documentPath) }
        : {}),
    ...(info?.documentation.length
      ? { documentation: info.documentation }
      : {}),
  }
}

function directCallees(
  index: ScipIndex,
  repoPath: string,
  caller: IndexedOccurrence,
): Record<string, unknown>[] {
  const scope = definitionScope(caller)
  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []

  for (const reference of index.occurrences) {
    if (
      reference.documentPath !== caller.documentPath ||
      reference.symbol === caller.symbol ||
      (reference.symbolRoles & 3) !== 0 ||
      !containsRange(scope, reference.range) ||
      !isCallable(index, reference)
    ) {
      continue
    }
    const key = `${reference.symbol}\0${reference.documentPath}\0${reference.range.startLine}\0${reference.range.startCharacter}`
    if (seen.has(key)) continue
    seen.add(key)
    const calleeDefinition = index.definitions.find(
      (definition) => definition.symbol === reference.symbol,
    )
    rows.push({
      caller: displayName(index, caller.symbol),
      caller_symbol: caller.symbol,
      caller_file_path: resolve(repoPath, caller.documentPath),
      called: displayName(index, reference.symbol),
      called_symbol: reference.symbol,
      call_file_path: resolve(repoPath, reference.documentPath),
      call_range: rangeResult(reference.range),
      ...(calleeDefinition
        ? {
            called_file_path: resolve(repoPath, calleeDefinition.documentPath),
          }
        : {}),
    })
  }
  return rows
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function executeScipGraphQuery(
  payload: ScipGraphPayload,
): Promise<ScipGraphResult> {
  let loaded: { index?: ScipIndex; missing: boolean }
  try {
    loaded = await loadIndex(payload.scipIndexPath)
  } catch (error) {
    return {
      ok: false,
      results: [],
      error: `Failed to read SCIP index: ${errorMessage(error)}`,
    }
  }

  if (loaded.missing) {
    return {
      ok: true,
      results: [],
      note: "SCIP index unavailable for this checkout; use search or find_symbol_references instead.",
    }
  }
  const index = loaded.index
  if (!index) {
    return { ok: false, results: [], error: "SCIP index could not be loaded" }
  }

  const limit = Math.max(1, Math.min(payload.limit ?? 50, 200))

  if (payload.primitive === "find_symbol") {
    const anchor = payload.symbol ?? payload.module
    const seen = new Set<string>()
    const rows: Record<string, unknown>[] = []
    for (const definition of index.definitions) {
      if (
        !fileMatches(
          payload.repoPath,
          definition.documentPath,
          payload.filePath,
        ) ||
        (anchor &&
          !(payload.module
            ? matchesModule(index, definition.symbol, payload.module)
            : matchesSymbol(index, definition.symbol, anchor, true)))
      ) {
        continue
      }
      const key = `${definition.symbol}\0${definition.documentPath}\0${definition.range.startLine}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(
        symbolResult(index, payload.repoPath, definition.symbol, definition),
      )
    }
    return { ok: true, results: rows.slice(0, limit) }
  }

  if (payload.primitive === "get_imports") {
    const anchor = payload.module ?? payload.symbol
    const rows = index.occurrences
      .filter(
        (occurrence) =>
          (occurrence.symbolRoles & 2) !== 0 &&
          fileMatches(
            payload.repoPath,
            occurrence.documentPath,
            payload.filePath,
          ) &&
          (!anchor ||
            (payload.module
              ? matchesModule(index, occurrence.symbol, payload.module)
              : matchesSymbol(index, occurrence.symbol, anchor, true))),
      )
      .map((occurrence) => ({
        ...symbolResult(index, payload.repoPath, occurrence.symbol, occurrence),
        module: displayName(index, occurrence.symbol),
      }))
    return { ok: true, results: rows.slice(0, limit) }
  }

  if (!payload.symbol) {
    return {
      ok: false,
      results: [],
      error: `${payload.primitive} requires symbol`,
    }
  }

  if (payload.primitive === "get_callees") {
    const callers = findDefinitions(
      index,
      payload.repoPath,
      payload.symbol,
      payload.filePath,
    ).filter((definition) => isCallable(index, definition))
    return {
      ok: true,
      results: callers
        .flatMap((caller) => directCallees(index, payload.repoPath, caller))
        .slice(0, limit),
    }
  }

  if (payload.primitive === "get_callers") {
    const targetSymbols = new Set(
      [
        ...index.symbols.keys(),
        ...index.occurrences.map(({ symbol }) => symbol),
      ]
        .filter((symbol) => matchesSymbol(index, symbol, payload.symbol ?? ""))
        .filter((symbol) =>
          payload.filePath
            ? index.definitions.some(
                (definition) =>
                  definition.symbol === symbol &&
                  fileMatches(
                    payload.repoPath,
                    definition.documentPath,
                    payload.filePath,
                  ),
              )
            : true,
        ),
    )
    const rows: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const reference of index.occurrences) {
      if (
        !targetSymbols.has(reference.symbol) ||
        (reference.symbolRoles & 3) !== 0
      ) {
        continue
      }
      const caller = findEnclosingDefinition(index, reference, undefined, true)
      if (!caller) continue
      const key = `${caller.symbol}\0${reference.documentPath}\0${reference.range.startLine}\0${reference.range.startCharacter}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        caller: displayName(index, caller.symbol),
        caller_symbol: caller.symbol,
        caller_file_path: resolve(payload.repoPath, caller.documentPath),
        called: displayName(index, reference.symbol),
        called_symbol: reference.symbol,
        call_file_path: resolve(payload.repoPath, reference.documentPath),
        call_range: rangeResult(reference.range),
      })
    }
    return { ok: true, results: rows.slice(0, limit) }
  }

  if (payload.primitive === "get_type_hierarchy") {
    const matchedSymbols = [...index.symbols.keys()].filter(
      (symbol) =>
        matchesSymbol(index, symbol, payload.symbol ?? "") &&
        (!payload.filePath ||
          index.definitions.some(
            (definition) =>
              definition.symbol === symbol &&
              fileMatches(
                payload.repoPath,
                definition.documentPath,
                payload.filePath,
              ),
          )),
    )
    const matched = new Set(matchedSymbols)
    const rows: Record<string, unknown>[] = []
    for (const symbol of matchedSymbols) {
      const info = index.symbols.get(symbol)
      for (const relationship of info?.relationships ?? []) {
        if (!relationship.isImplementation) continue
        rows.push({
          relation: "implements",
          source: symbolResult(index, payload.repoPath, symbol),
          target: symbolResult(index, payload.repoPath, relationship.symbol),
        })
      }
    }
    for (const info of index.symbols.values()) {
      for (const relationship of info.relationships) {
        if (!relationship.isImplementation || !matched.has(relationship.symbol))
          continue
        rows.push({
          relation: "implemented_by",
          source: symbolResult(index, payload.repoPath, relationship.symbol),
          target: symbolResult(index, payload.repoPath, info.symbol),
        })
      }
    }
    return { ok: true, results: rows.slice(0, limit) }
  }

  if (payload.primitive === "get_containing_scope") {
    if (!payload.filePath) {
      return {
        ok: false,
        results: [],
        error: "get_containing_scope requires filePath",
      }
    }
    const targets = index.occurrences.filter(
      (occurrence) =>
        fileMatches(
          payload.repoPath,
          occurrence.documentPath,
          payload.filePath,
        ) && matchesSymbol(index, occurrence.symbol, payload.symbol ?? ""),
    )
    const rows = targets.map((target) => {
      const info = index.symbols.get(target.symbol)
      const enclosingFromMetadata = info?.enclosingSymbol
        ? index.definitions.find(
            (definition) => definition.symbol === info.enclosingSymbol,
          )
        : undefined
      const enclosing =
        enclosingFromMetadata ??
        findEnclosingDefinition(index, target, target.symbol)
      return {
        symbol: target.symbol,
        symbol_name: displayName(index, target.symbol),
        file_path: resolve(payload.repoPath, target.documentPath),
        range: rangeResult(target.range),
        scope_type: enclosing
          ? kindName(index.symbols.get(enclosing.symbol)?.kind ?? 0)
          : "file",
        scope_name: enclosing
          ? displayName(index, enclosing.symbol)
          : target.documentPath,
        ...(enclosing
          ? {
              scope_symbol: enclosing.symbol,
              scope_range: rangeResult(definitionScope(enclosing)),
            }
          : {}),
      }
    })
    return { ok: true, results: rows.slice(0, limit) }
  }

  if (payload.primitive === "trace_path") {
    if (!payload.filePath) {
      return {
        ok: false,
        results: [],
        error: "trace_path requires filePath",
      }
    }
    const maxDepth = Math.max(1, Math.min(payload.maxDepth ?? 5, 10))
    const queue = findDefinitions(
      index,
      payload.repoPath,
      payload.symbol,
      payload.filePath,
    )
      .filter((definition) => isCallable(index, definition))
      .map((definition) => ({ definition, depth: 0 }))
    const visited = new Set<string>()
    const rows: Record<string, unknown>[] = []
    let reachedEnd = false

    while (queue.length > 0 && rows.length < limit) {
      const current = queue.shift()
      if (!current || current.depth >= maxDepth) continue
      const visitKey = `${current.definition.symbol}\0${current.definition.documentPath}`
      if (visited.has(visitKey)) continue
      visited.add(visitKey)

      for (const edge of directCallees(
        index,
        payload.repoPath,
        current.definition,
      )) {
        const calledSymbol =
          typeof edge.called_symbol === "string" ? edge.called_symbol : ""
        rows.push({ depth: current.depth + 1, ...edge })
        if (
          payload.endSymbol &&
          matchesSymbol(index, calledSymbol, payload.endSymbol)
        ) {
          reachedEnd = true
          break
        }
        if (current.depth + 1 < maxDepth) {
          for (const definition of index.definitions) {
            if (
              definition.symbol === calledSymbol &&
              isCallable(index, definition)
            ) {
              queue.push({ definition, depth: current.depth + 1 })
            }
          }
        }
        if (rows.length >= limit) break
      }
      if (reachedEnd) break
    }

    return {
      ok: true,
      results: rows,
      ...(payload.endSymbol && !reachedEnd
        ? {
            note: `No call path reached end symbol "${payload.endSymbol}" within maxDepth=${maxDepth}`,
          }
        : {}),
    }
  }

  return {
    ok: false,
    results: [],
    error: `Unknown graph primitive: ${payload.primitive satisfies never}`,
  }
}
