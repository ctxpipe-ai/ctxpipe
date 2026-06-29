import { OrganizationSwitcher } from "@daveyplate/better-auth-ui"
import { useRouter } from "@tanstack/react-router"
import { useState } from "react"
import {
  OrganizationCreateDialog,
  OrganizationCreateTrigger,
} from "@/components/organization/OrganizationCreateDialog"
import { useUserPreferences } from "@/lib/user-preferences"

type SideNavOrganizationButtonProps = {
  expanded: boolean
}

export function SideNavOrganizationButton({
  expanded,
}: SideNavOrganizationButtonProps) {
  const router = useRouter()
  const [, setPreferences] = useUserPreferences()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  return (
    <>
      <OrganizationSwitcher
        hidePersonal
        hideCreate
        title={expanded ? "Organization switcher" : "Organization"}
        side="right"
        align="end"
        onSetActive={(org) => {
          if (!org) return
          setPreferences((prev) => ({
            ...prev,
            selectedOrganizationSlug: org.slug,
          }))
          router.navigate({
            to: "/$orgSlug",
            params: { orgSlug: org.slug },
            replace: true,
          })
        }}
        size={expanded ? "default" : "icon"}
        classNames={{
          trigger: {
            base: "flex w-full bg-transparent text-zinc-300 hover:bg-transparent hover:text-white hover:bg-teal-900/30 py-1.5 rounded-none",
          },
          content: {
            base: "!rounded-none",
            menuItem: "!rounded-none",
            separator: "!rounded-none",
          },
        }}
      />
      <OrganizationCreateTrigger
        expanded={expanded}
        onPress={() => setCreateDialogOpen(true)}
      />
      <OrganizationCreateDialog
        isOpen={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(org) => {
          setPreferences((prev) => ({
            ...prev,
            selectedOrganizationSlug: org.slug,
          }))
          void router.navigate({
            to: "/$orgSlug/setup",
            params: { orgSlug: org.slug },
            replace: true,
          })
        }}
      />
    </>
  )
}
