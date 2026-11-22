import type { authClient } from "@/lib/auth-client"

type AccountClient = Pick<typeof authClient, "listAccounts" | "unlinkAccount">

/**
 * Unlinks a provider account of the signed-in user.
 *
 * better-auth-ui sends the provider's account id, but Better Auth 1.7 finds
 * the account by its own row id. This function finds the row of the provider
 * account and unlinks it by that row id.
 */
export async function unlinkProviderAccount(
  client: AccountClient,
  params: { providerId: string; accountId?: string },
): Promise<void> {
  const { data: accounts, error: listError } = await client.listAccounts()
  if (listError) throw listError
  const row = accounts.find(
    (account) =>
      account.providerId === params.providerId &&
      (params.accountId === undefined ||
        account.accountId === params.accountId),
  )
  const { error } = await client.unlinkAccount({
    accountId: row?.id ?? params.accountId ?? "",
  })
  if (error) throw error
}
