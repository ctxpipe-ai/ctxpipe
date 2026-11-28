/** The time budget of a retrieval ended before a step could start or end. */
export class BudgetSpentError extends Error {
  override readonly name = "BudgetSpentError"
}
