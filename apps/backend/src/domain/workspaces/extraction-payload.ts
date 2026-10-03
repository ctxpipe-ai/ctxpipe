/**
 * Shallow merge for incremental extraction: consumer-inferred stubs must not clobber
 * richer payloads; full extractions must replace prior stubs.
 */
export function mergeExtractionPayloads<
  Existing extends Record<string, unknown>,
  Incoming extends Record<string, unknown>,
>(existing: Existing, incoming: Incoming): Existing & Incoming {
  if (incoming.inferredFromConsumer === true) {
    return { ...incoming, ...existing }
  }
  return { ...existing, ...incoming }
}
