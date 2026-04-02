/**
 * Code-enforced policy for Zoekt vs CGC: discovery starts with Zoekt unless the
 * caller uses structural graph tools with explicit anchors (see tool implementations).
 */

export function assertStructuralGraphAnchor(params: {
  symbol?: string
  filePath?: string
  module?: string
}): void {
  if (
    !params.symbol?.trim() &&
    !params.filePath?.trim() &&
    !params.module?.trim()
  ) {
    throw new Error(
      "Structural graph tools require at least one of: symbol, filePath, module (planner policy).",
    )
  }
}
