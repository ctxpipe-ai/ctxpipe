"use client"

import {
  AuthUIContext,
  OrganizationCellView,
  OrganizationLogo,
  useCurrentOrganization,
} from "@daveyplate/better-auth-ui"
import type { Organization } from "better-auth/plugins/organization"
import { ChevronsUpDown, PlusCircleIcon, SettingsIcon } from "lucide-react"
import { useCallback, useContext, useEffect, useMemo, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { SideNavOrganizationCreateDialog } from "./SideNavOrganizationCreateDialog"

const triggerClassName =
  "flex w-full items-center bg-transparent text-zinc-300 hover:bg-transparent hover:text-white hover:bg-teal-900/30 py-1.5 rounded-none !size-full"

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

  const classNames = {
    trigger: {
      base: triggerClassName,
    },
    content: {
      base: "!rounded-none",
      menuItem: "!rounded-none",
      separator: "!rounded-none",
      organization: undefined,
    },
  }

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

  const displayedOrganization = useMemo(() => {
    if (routeOrgSlug && organizations) {
      const fromRoute = organizations.find((org) => org.slug === routeOrgSlug)
      if (fromRoute) return fromRoute
    }
    return activeOrganization
  }, [routeOrgSlug, organizations, activeOrganization])

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
      setActiveOrganizationPending(true)
      try {
        onSetActive(organization)
        await authClient.organization.setActive({
          organizationId: organization.id,
          fetchOptions: { throw: true },
        })
        organizationRefetch?.()
      } catch (error) {
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
    [authClient, onSetActive, organizationRefetch, toast],
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

  const size = expanded ? "default" : "icon"

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger
          aria-label={expanded ? "Organization switcher" : "Organization"}
          render={
            <button
              type="button"
              className={cn(
                size === "icon"
                  ? "size-fit rounded-full"
                  : "!p-2 h-fit items-center",
                classNames.trigger.base,
              )}
            />
          }
        >
          {size === "icon" ? (
            <OrganizationLogo
              key={displayedOrganization?.logo}
              isPending={isPending}
              organization={displayedOrganization}
              aria-label={contextLocalization.ORGANIZATION}
              localization={contextLocalization}
            />
          ) : (
            <span className="flex w-full min-w-0 items-center gap-2">
              <OrganizationCellView
                classNames={classNames.content.organization}
                isPending={isPending}
                localization={contextLocalization}
                organization={displayedOrganization}
                size={size}
              />
              <ChevronsUpDown className="ml-auto size-4 shrink-0 self-center" />
            </span>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          className={classNames.content.base}
          align="end"
          side="right"
        >
          <div
            className={`flex items-center justify-between gap-2 p-2 ${classNames.content.menuItem}`}
          >
            <OrganizationCellView
              classNames={classNames.content.organization}
              isPending={isPending || activeOrganizationPending}
              organization={displayedOrganization}
              localization={contextLocalization}
            />
            {!isPending && settingsHref ? (
              <Link href={settingsHref}>
                <button
                  type="button"
                  aria-label="Organization settings"
                  className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-none bg-transparent text-zinc-300 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
                  onClick={() => setDropdownOpen(false)}
                >
                  <SettingsIcon className="size-4" />
                </button>
              </Link>
            ) : null}
          </div>

          <DropdownMenuSeparator className={classNames.content.separator} />

          {organizations?.map(
            (organization) =>
              organization.id !== displayedOrganization?.id && (
                <DropdownMenuItem
                  key={organization.id}
                  className={classNames.content.menuItem}
                  onClick={() => {
                    void switchOrganization(organization)
                  }}
                >
                  <OrganizationCellView
                    classNames={classNames.content.organization}
                    isPending={isPending}
                    localization={contextLocalization}
                    organization={organization}
                  />
                </DropdownMenuItem>
              ),
          )}

          {organizations && organizations.length > 1 ? (
            <DropdownMenuSeparator className={classNames.content.separator} />
          ) : null}

          {!isPending && sessionData ? (
            <DropdownMenuItem
              className={classNames.content.menuItem}
              onClick={() => setIsCreateOrgDialogOpen(true)}
            >
              <PlusCircleIcon className="size-4" />
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
