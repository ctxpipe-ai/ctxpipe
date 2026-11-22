import type { AuthHooks } from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"

import { authClient } from "@/lib/auth-client"

// better-auth-ui identifies a linked account by the provider's account id, but
// Better Auth 1.7 finds the account by its own row id. These functions find the
// row of the provider account first.

type AccountClient = Pick<
  typeof authClient,
  "listAccounts" | "unlinkAccount" | "accountInfo"
>

async function accountRowId(
  client: AccountClient,
  account: { providerId?: string; accountId?: string },
): Promise<string> {
  const { data: accounts, error } = await client.listAccounts()
  if (error) throw error
  const row = accounts.find(
    (candidate) =>
      (account.providerId === undefined ||
        candidate.providerId === account.providerId) &&
      (account.accountId === undefined ||
        candidate.accountId === account.accountId),
  )
  return row?.id ?? account.accountId ?? ""
}

/** Unlinks a provider account of the signed-in user. */
export async function unlinkProviderAccount(
  client: AccountClient,
  params: { providerId: string; accountId?: string },
): Promise<void> {
  const { error } = await client.unlinkAccount({
    accountId: await accountRowId(client, params),
  })
  if (error) throw error
}

/** The profile that the provider gives for a linked account. */
export async function providerAccountInfo(
  client: AccountClient,
  providerAccountId: string | undefined,
) {
  const { data, error } = await client.accountInfo({
    query: {
      accountId: await accountRowId(client, { accountId: providerAccountId }),
    },
  })
  if (error) throw error
  return data
}

type AccountInfo = NonNullable<ReturnType<AuthHooks["useAccountInfo"]>["data"]>

/** better-auth-ui's `useAccountInfo` hook, with the row id lookup. */
export const useProviderAccountInfo: AuthHooks["useAccountInfo"] = (params) => {
  const providerAccountId = (params as { query?: { accountId?: string } })
    ?.query?.accountId
  const query = useQuery({
    queryKey: ["auth", "accountInfo", providerAccountId],
    queryFn: () => providerAccountInfo(authClient, providerAccountId),
  })
  return {
    // better-auth-ui types `user` as the Better Auth 1.6 user; 1.7 gives the
    // provider profile. The settings page reads only `user.email`.
    data: query.data
      ? ({ user: query.data.user } as unknown as AccountInfo)
      : null,
    isPending: query.isPending,
    isRefetching: query.isRefetching,
  }
}
