import { useRouter } from "@tanstack/react-router"
import { orgSlugFromPathname } from "@/lib/hyperdxAttributes"
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
  const routeOrgSlug =
    orgSlugFromPathname(router.state?.location.pathname ?? "") || null

  return (
    <SideNavOrganizationSwitcher
      expanded={expanded}
      routeOrgSlug={routeOrgSlug}
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
