import { useListOrganizations } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

/**
 * The stored organization if the list has it. Otherwise the first
 * organization, or null when the list is empty. While the list is unknown
 * (`undefined`), no stored slug is safe to use: it can name a deleted
 * organization.
 */
export function resolveSelectedOrganizationSlug(
  storedSlug: string | null,
  organizationSlugs: readonly string[] | undefined,
): string | null {
  if (!organizationSlugs) return null
  if (storedSlug && organizationSlugs.includes(storedSlug)) return storedSlug
  return organizationSlugs[0] ?? null
}

/**
 * The organization that the shell uses when the path names none. It uses the
 * stored preference only if the organization list has that slug. While the
 * first load of the list is pending, it returns null. It does not change the
 * stored preference.
 */
export function useSelectedOrganizationSlug(): string | null {
  const { data } = useListOrganizations()
  const [{ selectedOrganizationSlug: storedSlug }] = useUserPreferences()
  return resolveSelectedOrganizationSlug(
    storedSlug,
    Array.isArray(data)
      ? data.map((organization) => organization.slug)
      : undefined,
  )
}
