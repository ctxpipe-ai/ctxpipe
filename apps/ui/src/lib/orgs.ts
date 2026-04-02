import { useListOrganizations } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export function usePreferredOrganization() {
  const { data: organizations, isPending: orgsPending } =
    useListOrganizations()
  const [preferences] = useUserPreferences()

  const defaultFallbackOrg = organizations?.[0]
  let targetOrganization = defaultFallbackOrg

  const hasMultipleOrgs = organizations && organizations.length > 1
  if (hasMultipleOrgs) {
    const storedSlug = preferences.selectedOrganizationSlug
    const matchingOrg = storedSlug
      ? organizations.find((org) => org.slug === storedSlug)
      : undefined
    targetOrganization = matchingOrg ?? defaultFallbackOrg
  }

  return { organizations, targetOrganization, orgsPending }
}
