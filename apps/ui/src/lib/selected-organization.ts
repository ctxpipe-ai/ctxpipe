import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useListOrganizations } from "@/lib/auth-client"
import { orgGateKeys } from "@/lib/org-gate"
import { useUserPreferences } from "@/lib/user-preferences"

/**
 * The stored organization if the user still has it. Otherwise the first
 * organization, or null when the user has none. While the list is unknown
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
 * The organization that the shell uses when the path names none. It reads
 * the stored preference only if the organization list still has it. When the
 * list has no such organization (the user deleted it, or lost access), this
 * clears the preference and the cached org gates, so that no page reads them.
 */
export function useSelectedOrganizationSlug(): string | null {
  const queryClient = useQueryClient()
  const { data, isPending, isRefetching } = useListOrganizations()
  const [{ selectedOrganizationSlug: storedSlug }, updatePreferences] =
    useUserPreferences()
  const organizationSlugs =
    !isPending && !isRefetching && Array.isArray(data)
      ? data.map((organization) => organization.slug)
      : undefined
  const isStale =
    storedSlug !== null &&
    organizationSlugs !== undefined &&
    !organizationSlugs.includes(storedSlug)
  // A page can store the slug again before the list shows a new organization.
  // Clear each stale slug once, so that the two do not take turns forever.
  const clearedSlug = useRef<string | null>(null)

  useEffect(() => {
    if (!isStale || clearedSlug.current === storedSlug) return
    clearedSlug.current = storedSlug
    updatePreferences((prev) =>
      prev.selectedOrganizationSlug === storedSlug
        ? { ...prev, selectedOrganizationSlug: null }
        : prev,
    )
    void queryClient.invalidateQueries({ queryKey: orgGateKeys.all })
  }, [isStale, storedSlug, queryClient, updatePreferences])

  return resolveSelectedOrganizationSlug(storedSlug, organizationSlugs)
}
