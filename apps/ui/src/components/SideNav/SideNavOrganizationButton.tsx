import { useRouter } from "@tanstack/react-router"
import { useUserPreferences } from "@/lib/user-preferences"
import { SideNavOrganizationSwitcher } from "./SideNavOrganizationSwitcher"

type SideNavOrganizationButtonProps = {
  expanded: boolean
}

export function SideNavOrganizationButton({
  expanded,
}: SideNavOrganizationButtonProps) {
  const router = useRouter()
  const [, setPreferences] = useUserPreferences()

  return (
    <SideNavOrganizationSwitcher
      expanded={expanded}
      onSetActive={(org) => {
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
    />
  )
}
