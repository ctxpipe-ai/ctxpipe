import { useEffect, useState } from "react"

/**
 * The current time in ms, updated every `intervalMs` while `active`. A timer
 * is a subscription to the clock, not a data fetch, so it uses an effect.
 */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
