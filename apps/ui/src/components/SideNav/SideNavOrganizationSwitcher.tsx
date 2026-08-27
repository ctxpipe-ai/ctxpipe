"use client"

import {
  AuthUIContext,
  OrganizationCellView,
  OrganizationLogo,
  useCurrentOrganization,
} from "@daveyplate/better-auth-ui"
import { IconPlus, IconSelector, IconSettings } from "@tabler/icons-react"
import type { Organization } from "better-auth/plugins/organization"
import { useCallback, useContext, useEffect, useMemo, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useUrgentValue } from "@/lib/useUrgentValue"
import { cn } from "@/lib/utils"
import { SideNavOrganizationCreateDialog } from "./SideNavOrganizationCreateDialog"
import {
  sideNavAccountAvatarClassNames,
  sideNavAccountOrgViewClassNames,
  sideNavAccountTriggerClassName,
  sideNavTrailingSlotClassName,
} from "./sideNavStyles"

type SideNavOrganizationSwitcherProps = {
  expanded: boolean
  routeOrgSlug: string | null
  onSetActive: (organization: Organization) => void
}

export function SideNavOrganizationSwitcher({
  expanded,
  routeOrgSlug,
  onSetActive,
}: SideNavOrganizationSwitcherProps) {
  const {
    authClient,
    hooks: { useSession, useListOrganizations },
    localization: contextLocalization,
    organization: organizationOptions,
    toast,
    Link,
  } = useContext(AuthUIContext)

  const [activeOrganizationPending, setActiveOrganizationPending] =
    useState(false)
  const [isCreateOrgDialogOpen, setIsCreateOrgDialogOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const { data: sessionData, isPending: sessionPending } = useSession()
  const { data: organizations, isPending: organizationsPending } =
    useListOrganizations()
  const {
    data: activeOrganization,
    isPending: organizationPending,
    isRefetching: organizationRefetching,
    refetch: organizationRefetch,
  } = useCurrentOrganization({ slug: organizationOptions?.slug })

  const [urgentOrgSlug, setUrgentOrgSlug] = useUrgentValue(
    routeOrgSlug,
    routeOrgSlug ?? "",
  )

  const displayedOrganization = useMemo(() => {
    if (urgentOrgSlug && organizations) {
      const fromUrgent = organizations.find((org) => org.slug === urgentOrgSlug)
      if (fromUrgent) return fromUrgent
    }
    if (routeOrgSlug && organizations) {
      const fromRoute = organizations.find((org) => org.slug === routeOrgSlug)
      if (fromRoute) return fromRoute
    }
    return activeOrganization
  }, [urgentOrgSlug, routeOrgSlug, organizations, activeOrganization])

  const isPending =
    organizationsPending ||
    sessionPending ||
    activeOrganizationPending ||
    organizationPending

  // biome-ignore lint/correctness/useExhaustiveDependencies: mirror library switcher refetch reset
  useEffect(() => {
    if (organizationRefetching) return
    setActiveOrganizationPending(false)
  }, [activeOrganization, organizationRefetching])

  useEffect(() => {
    if (!routeOrgSlug || !organizations || organizationPending) return
    const routeOrg = organizations.find((org) => org.slug === routeOrgSlug)
    if (!routeOrg || activeOrganization?.id === routeOrg.id) return

    let cancelled = false
    void authClient.organization
      .setActive({
        organizationId: routeOrg.id,
        fetchOptions: { throw: true },
      })
      .then(() => {
        if (!cancelled) organizationRefetch?.()
      })
      .catch(() => {
        /* best-effort sync with route */
      })

    return () => {
      cancelled = true
    }
  }, [
    routeOrgSlug,
    organizations,
    activeOrganization?.id,
    organizationPending,
    authClient,
    organizationRefetch,
  ])

  const switchOrganization = useCallback(
    async (organization: Organization) => {
      setUrgentOrgSlug(organization.slug)
      setActiveOrganizationPending(true)
      try {
        onSetActive(organization)
        await authClient.organization.setActive({
          organizationId: organization.id,
          fetchOptions: { throw: true },
        })
        organizationRefetch?.()
      } catch (error) {
        setUrgentOrgSlug(routeOrgSlug)
        toast({
          variant: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to switch organisation",
        })
        setActiveOrganizationPending(false)
      }
    },
    [
      authClient,
      onSetActive,
      organizationRefetch,
      toast,
      routeOrgSlug,
      setUrgentOrgSlug,
    ],
  )

  useEffect(() => {
    if (
      !displayedOrganization &&
      !activeOrganizationPending &&
      organizations &&
      organizations.length > 0 &&
      !sessionPending &&
      !organizationPending &&
      !organizationOptions?.slug &&
      !routeOrgSlug
    ) {
      void switchOrganization(organizations[0])
    }
  }, [
    displayedOrganization,
    activeOrganizationPending,
    organizations,
    sessionPending,
    organizationPending,
    organizationOptions?.slug,
    routeOrgSlug,
    switchOrganization,
  ])

  const settingsHref = useMemo(() => {
    if (!displayedOrganization) return null
    return `${organizationOptions?.basePath ?? "/.auth/organization"}/${organizationOptions?.viewPaths?.SETTINGS ?? "settings"}`
  }, [displayedOrganization, organizationOptions])

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger
          aria-label={expanded ? "Organization switcher" : "Organization"}
          render={
            <button
              type="button"
              className={cn(sideNavAccountTriggerClassName(expanded))}
            />
          }
        >
          {expanded ? (
            <>
              <OrganizationCellView
                classNames={sideNavAccountOrgViewClassNames}
                isPending={isPending}
                localization={contextLocalization}
                organization={displayedOrganization}
              />
              <span className={sideNavTrailingSlotClassName}>
                <IconSelector
                  className="size-4 text-zinc-400"
                  stroke={1.4}
                  aria-hidden
                />
              </span>
            </>
          ) : (
            <OrganizationLogo
              key={displayedOrganization?.logo}
              classNames={sideNavAccountAvatarClassNames}
              isPending={isPending}
              organization={displayedOrganization}
              aria-label={contextLocalization.ORGANIZATION}
              localization={contextLocalization}
            />
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent className="rounded-md" align="end" side="right">
          <div className="flex items-center justify-between gap-2 p-2">
            <OrganizationCellView
              classNames={sideNavAccountOrgViewClassNames}
              isPending={isPending || activeOrganizationPending}
              organization={displayedOrganization}
              localization={contextLocalization}
            />
            {!isPending && settingsHref ? (
              <Link href={settingsHref}>
                <button
                  type="button"
                  aria-label="Organization settings"
                  className="ml-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
                  onClick={() => setDropdownOpen(false)}
                >
                  <IconSettings className="size-4" stroke={1.4} aria-hidden />
                </button>
              </Link>
            ) : null}
          </div>

          <DropdownMenuSeparator />

          {organizations?.map(
            (organization) =>
              organization.id !== displayedOrganization?.id && (
                <DropdownMenuItem
                  key={organization.id}
                  className="rounded-md"
                  onClick={() => {
                    void switchOrganization(organization)
                  }}
                >
                  <OrganizationCellView
                    classNames={sideNavAccountOrgViewClassNames}
                    isPending={isPending}
                    localization={contextLocalization}
                    organization={organization}
                  />
                </DropdownMenuItem>
              ),
          )}

          {organizations && organizations.length > 1 ? (
            <DropdownMenuSeparator />
          ) : null}

          {!isPending && sessionData ? (
            <DropdownMenuItem
              className="rounded-md"
              onClick={() => setIsCreateOrgDialogOpen(true)}
            >
              <IconPlus className="size-4" stroke={1.4} aria-hidden />
              {contextLocalization.CREATE_ORGANIZATION}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <SideNavOrganizationCreateDialog
        isOpen={isCreateOrgDialogOpen}
        onOpenChange={setIsCreateOrgDialogOpen}
      />
    </>
  )
}
