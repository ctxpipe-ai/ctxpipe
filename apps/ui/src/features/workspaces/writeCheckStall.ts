import { createContext, useContext } from "react"

/**
 * The surface stops polling a write-access check that runs too long. The
 * settings pane shows that state and restarts the poll.
 */
export const WriteCheckStallContext = createContext<{
  stalled: boolean
  restart: () => void
}>({ stalled: false, restart: () => {} })

export function useWriteCheckStall() {
  return useContext(WriteCheckStallContext)
}
