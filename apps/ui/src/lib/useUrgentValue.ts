import { useState } from "react"

/**
 * Selected chrome that must move in the click handler, then reconcile with the
 * URL (share / refresh / back). See the React skill **Feel fast**.
 */
export function useUrgentValue<T>(
  committed: T,
  committedKey: string,
): [T, (next: T) => void] {
  const [value, setValue] = useState(committed)
  const [seenKey, setSeenKey] = useState(committedKey)
  if (committedKey !== seenKey) {
    setSeenKey(committedKey)
    setValue(committed)
  }
  return [value, setValue]
}
