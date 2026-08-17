import { withOrgDbContext } from "../../db/client.js"

const DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT = "20min"

export function withNodeOrgDbContext<TState extends { orgId: string }, TResult>(
  node: (state: TState) => Promise<TResult>,
) {
  return async (state: TState) =>
    withOrgDbContext(state.orgId, () => node(state), {
      idleInTransactionSessionTimeout:
        DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT,
    })
}
