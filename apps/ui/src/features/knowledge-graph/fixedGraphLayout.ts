import { createContext } from "react"

/**
 * Fixed positions of the graph points, by point id, in the coordinates of
 * the Cosmograph space. When each point has a position, the canvas shows the
 * graph at these positions and runs no layout. Only stories give it: a
 * screenshot then does not wait for a layout that the CPU renderer of the
 * screenshot container computes slowly.
 */
export const FixedGraphLayoutContext = createContext<Readonly<
  Record<string, readonly [number, number]>
> | null>(null)
