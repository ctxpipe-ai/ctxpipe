/** LangChain concatenates `response_metadata.model_name` across stream chunks. */
export function collapseRepeatedModelName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 2) return name
  for (let size = 1; size <= trimmed.length / 2; size++) {
    if (trimmed.length % size !== 0) continue
    const unit = trimmed.slice(0, size)
    const repeats = trimmed.length / size
    if (repeats > 1 && unit.repeat(repeats) === trimmed) return unit
  }
  return name
}
