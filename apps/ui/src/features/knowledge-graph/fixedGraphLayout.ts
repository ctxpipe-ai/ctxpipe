import { createContext } from "react"

/** Positions of the graph points, by point id, in Cosmograph space. */
export type FixedGraphLayout = Readonly<
  Record<string, readonly [number, number]>
>

/**
 * Fixed positions of the graph points. With it, the canvas shows the graph
 * at these positions and runs no layout; a point with no position is an
 * error. Only stories give it: a screenshot then does not wait for a layout
 * that the CPU renderer of the screenshot container computes slowly. So the
 * screenshots do not show the layout and the reveal path of the product.
 */
export const FixedGraphLayoutContext = createContext<FixedGraphLayout | null>(
  null,
)
