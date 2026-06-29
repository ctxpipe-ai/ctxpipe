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
import { Button } from "@/components/ui/Button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SideNavOrganizationCreateDialog } from "./SideNavOrganizationCreateDialog"

type SideNavOrganizationSwitcherProps = {
  expanded: boolean
  onSetActive: (organization: Organization) => void
}

export function SideNavOrganizationSwitcher({
  expanded,
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
      base: "flex w-full bg-transparent text-zinc-300 hover:bg-transparent hover:text-white hover:bg-teal-900/30 py-1.5 rounded-none",
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
      !activeOrganization &&
      !activeOrganizationPending &&
      organizations &&
      organizations.length > 0 &&
      !sessionPending &&
      !organizationPending &&
      !organizationOptions?.slug
    ) {
      void switchOrganization(organizations[0])
    }
  }, [
    activeOrganization,
    activeOrganizationPending,
    organizations,
    sessionPending,
    organizationPending,
    organizationOptions?.slug,
    switchOrganization,
  ])

  const settingsHref = useMemo(() => {
    if (!activeOrganization) return null
    return `${organizationOptions?.basePath ?? "/.auth/organization"}/${organizationOptions?.viewPaths?.SETTINGS ?? "settings"}`
  }, [activeOrganization, organizationOptions])

  const size = expanded ? "default" : "icon"

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger
          className={classNames.trigger.base}
          aria-label={expanded ? "Organization switcher" : "Organization"}
        >
          {size === "icon" ? (
            <OrganizationLogo
              key={activeOrganization?.logo}
              isPending={isPending}
              organization={activeOrganization}
              aria-label={contextLocalization.ORGANIZATION}
              localization={contextLocalization}
            />
          ) : (
            <span className="flex w-full items-center gap-2">
              <OrganizationCellView
                classNames={classNames.content.organization}
                isPending={isPending}
                localization={contextLocalization}
                organization={activeOrganization}
                size={size}
              />
              <ChevronsUpDown className="ml-auto size-4 shrink-0" />
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
              organization={activeOrganization}
              localization={contextLocalization}
            />
            {!isPending && settingsHref ? (
              <Link href={settingsHref}>
                <Button
                  size="icon"
                  variant="outline"
                  className="!size-8 ml-auto rounded-none"
                  onPress={() => setDropdownOpen(false)}
                >
                  <SettingsIcon className="size-4" />
                </Button>
              </Link>
            ) : null}
          </div>

          <DropdownMenuSeparator className={classNames.content.separator} />

          {organizations?.map(
            (organization) =>
              organization.id !== activeOrganization?.id && (
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
