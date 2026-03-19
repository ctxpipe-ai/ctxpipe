import { useEffect } from "react"
import { useListOrganizations } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export function usePreferredOrganization() {
  const { data: organizations } = useListOrganizations()
  const [preferences, updatePreferences] = useUserPreferences()

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

  useEffect(() => {
    if (
      targetOrganization &&
      targetOrganization.slug !== preferences.selectedOrganizationSlug
    ) {
      const slug = targetOrganization.slug
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: slug,
      }))
    }
  }, [targetOrganization, preferences.selectedOrganizationSlug, updatePreferences])

  return { organizations, targetOrganization }
}
