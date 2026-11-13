// The spend cap of a run of paid model calls: the bake-off (run.ts) and the
// judge panel (panel.ts).

/**
 * The spend of one run, with the cap `maxCost` in USD. A paid call starts
 * only while the spend is below the cap; calls that run finish, so the spend
 * can end above it. A call without a known cost (also a failed call) counts
 * as the most expensive call so far, and at least $0.10 (more than one image
 * call of the models of the plan).
 */
export function spendMeter(maxCost: number) {
  let spent = 0
  let highest = 0
  let unknownCost = 0
  return {
    /** True while a paid call can start. */
    open: () => spent < maxCost,
    /** Add the cost of one call, or null when it is not known. */
    count(cost: number | null) {
      if (cost === null) {
        unknownCost++
        spent += Math.max(highest, 0.1)
      } else {
        spent += cost
        highest = Math.max(highest, cost)
      }
    },
    totals: () => ({ spent, maxCost, unknownCost }),
  }
}
