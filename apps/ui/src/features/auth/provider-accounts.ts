import { AuthQueryContext } from "@daveyplate/better-auth-tanstack"
import type { AuthHooks } from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"
import { useContext } from "react"

import { authClient } from "@/lib/auth-client"

/**
 * better-auth-ui sends `account.accountId` (the provider's account id) to
 * `unlinkAccount` and `accountInfo`, but Better Auth 1.7 finds an account by
 * its own row id. better-auth-ui reads `accountId` for nothing else, so the
 * list that it gets carries the row id in that field.
 */
export function accountsWithRowIds<T extends { id: string; accountId: string }>(
  accounts: T[],
): T[] {
  return accounts.map((account) => ({ ...account, accountId: account.id }))
}

/**
 * better-auth-ui's `useListAccounts` hook, with the row id as `accountId`.
 * It uses the query key of better-auth-tanstack, so an unlink refreshes it.
 */
export const useListAccountsWithRowIds: AuthHooks["useListAccounts"] = () => {
  const { listAccountsKey } = useContext(AuthQueryContext)
  const query = useQuery({
    queryKey: listAccountsKey,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts()
      if (error) throw error
      return data
    },
    select: accountsWithRowIds,
  })
  return {
    data: query.data,
    isPending: query.isPending,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
  }
}
