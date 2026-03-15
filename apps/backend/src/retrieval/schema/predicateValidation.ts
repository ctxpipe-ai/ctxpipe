import { CoreRelType } from "./core.js"
import { ExtensionRelType } from "./extension.js"

const CORE_PREDICATES = new Set(CoreRelType.options)
const EXTENSION_PREDICATES = new Set(ExtensionRelType.options)

/** Additional predicates allowed for ingestion (e.g. repo contains chunk). */
const ALLOWED_INGESTION_PREDICATES = new Set(["contains"])

const ALL_VALID_PREDICATES = new Set([
  ...CORE_PREDICATES,
  ...EXTENSION_PREDICATES,
  ...ALLOWED_INGESTION_PREDICATES,
])

/**
 * Validates that a predicate is schema-constrained.
 * Accepts CoreRelType, ExtensionRelType, or allowed ingestion predicates.
 * @throws if predicate is not allowed
 */
export function validatePredicate(predicate: string): void {
  if (!ALL_VALID_PREDICATES.has(predicate)) {
    const allowed = [...ALL_VALID_PREDICATES].sort().join(", ")
    throw new Error(
      `Invalid predicate "${predicate}". Allowed: ${allowed}`,
    )
  }
}

export function isValidPredicate(predicate: string): boolean {
  return ALL_VALID_PREDICATES.has(predicate)
}
