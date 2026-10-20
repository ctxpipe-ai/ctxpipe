/**
 * The spend rules of the ingestion v2 proof (CTX-630). Pure functions: the
 * proof script (`ingestionV2Proof.ts`) calls them, and a test covers them
 * without a model.
 */
import { plannedIngestSkills } from "../domain/ingestion/ingestion-plan.js"

/**
 * USD that the proof holds back for each model step that is running. The
 * product has no hard limit on the cost of one step, so this is an
 * assumption: about 8 times the p90 estimate of one step (0.12 USD in
 * `estimateReingest`). The proof prints the highest cost that it saw for one
 * finished step, so a person can check the assumption after a run.
 */
export const STEP_RESERVE_USD = 1

/**
 * The reason to refuse the proof when the p90 estimate for all repositories
 * is over the cap, else null. This is the same estimate that the Upgrades UI
 * shows (`estimateReingest`); its `high` value is the p90 cost.
 */
export function estimateRefusal(
  estimate: { costUsd: { low: number; high: number } },
  capUsd: number,
): string | null {
  if (estimate.costUsd.high <= capUsd) return null
  return `The p90 cost estimate for all repositories is ${estimate.costUsd.high} USD, which is over the spend cap of ${capUsd} USD.`
}

/**
 * The spend guard. `spentUsd` is the cost of the finished steps (the earlier
 * repositories and this run). Each running model step holds back
 * `reserveUsd`. The proof stops the run when the spent and reserved total
 * reaches the cap. A stopped run starts no new step, and the running steps
 * cost at most what the guard reserved for them.
 */
export function spendGuard(input: {
  spentUsd: number
  inFlightModelSteps: number
  capUsd: number
  reserveUsd?: number
}): { reservedUsd: number; committedUsd: number; stop: boolean } {
  const reservedUsd =
    input.inFlightModelSteps * (input.reserveUsd ?? STEP_RESERVE_USD)
  const committedUsd = input.spentUsd + reservedUsd
  return { reservedUsd, committedUsd, stop: committedUsd >= input.capUsd }
}

/**
 * True when a shard step name (`skill:<root key>:<skill>[.<page>]:<workspace>`)
 * is a model step. A root key of `repository` is the repository scope.
 */
export function isModelStepName(stepName: string): boolean {
  const [prefix, key, skill] = stepName.split(":")
  if (prefix !== "skill" || !key || !skill) return false
  const name = skill.replace(/\.\d+$/, "")
  const scope = key === "repository" ? "repository" : "root"
  return plannedIngestSkills([name], scope).some((s) => s.run === "model")
}
