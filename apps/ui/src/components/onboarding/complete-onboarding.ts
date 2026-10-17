import type { QueryClient } from "@tanstack/react-query"
import { client, userClient } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
import { authClient, refetchSessionOnboardingComplete } from "@/lib/auth-client"
import { orgGateKeys } from "@/lib/org-gate"
import { isAdminRole } from "@/lib/session-user"

/**
 * Marks onboarding complete for the user and, for an owner or admin, for the
 * organization. Home shows the Get started guide for 14 days after this.
 * Throws when a call fails or the session does not show the change: the org
 * pages read the session, and a stale one sends the user back to onboarding.
 */
export async function completeOnboarding(
  orgSlug: string,
  queryClient: QueryClient,
) {
  // If the role request fails, continue. Then only the org-complete request
  // does not occur, and an owner or admin can send it later.
  const role = await authClient.organization
    .getActiveMemberRole({
      query: { organizationSlug: orgSlug },
      fetchOptions: { throw: true },
    })
    .then((result) => result.role)
    .catch(() => undefined)
  await Promise.all([
    userClient.api.v1.onboarding.user.complete
      .$post()
      .then((res) => readApiJson(res)),
    isAdminRole(role)
      ? client[":orgSlug"].api.v1.onboarding.complete
          .$post({ param: { orgSlug } })
          .then((res) => readApiJson(res))
      : null,
  ])
  if (!(await refetchSessionOnboardingComplete()))
    throw new Error("The session does not show onboarding as complete")
  // An org page that the user opened before onboarding cached its gate with
  // onboarding open. The org layout reads a cached gate as it is, so that
  // gate sends the user back to onboarding, and onboarding sends the user
  // to the org page again. Remove the gates that no page shows now.
  queryClient.removeQueries({ queryKey: orgGateKeys.all, type: "inactive" })
}
