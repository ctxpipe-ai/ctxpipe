import { isWorkflowControlSignal } from "./isSleepSignal.js"

/**
 * The values of child workflows that a run waits for with `allSettled`. A
 * child that still runs rejects with a control signal, so that signal goes
 * first: the run parks and waits. A failed child fails the run only when every
 * child has ended, so the run never cleans up while a sibling still runs.
 */
export function settledChildren<T>(settled: PromiseSettledResult<T>[]): T[] {
  const reasons = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  )
  const parked = reasons.find(isWorkflowControlSignal)
  if (parked !== undefined) throw parked
  if (reasons.length > 0) throw reasons[0]
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  )
}

/**
 * Run `count` child workflows in a sliding window of `size` (ADR-052,
 * revision 2026-11-25). `start(n)` runs child `n` with `step.runWorkflow`.
 * Child `n` starts when fewer than `size` children before it still run or
 * failed, so a new child starts when a child ends, and a slow child does not
 * stop the next ones. That count only goes down while the run waits, so each
 * replay starts the same children again. A failed child keeps its place in
 * the window. As in {@link settledChildren}, a child that still runs parks
 * the run first, and a failed child fails the run only when each child that
 * started has ended.
 */
export async function windowedChildren<T>(
  count: number,
  size: number,
  start: (n: number) => Promise<T>,
): Promise<T[]> {
  const values: T[] = []
  const failures: unknown[] = []
  let parked: unknown
  /** The children before `n` that still run or failed. */
  let open = 0
  for (let n = 0; n < count && open < size; n++) {
    try {
      values.push(await start(n))
    } catch (error) {
      open++
      if (isWorkflowControlSignal(error)) parked ??= error
      else failures.push(error)
    }
  }
  if (parked !== undefined) throw parked
  if (failures.length) throw failures[0]
  return values
}
