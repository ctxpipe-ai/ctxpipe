import { useRouter } from "@tanstack/react-router"
import { useUserPreferences } from "@/lib/user-preferences"
import { SideNavOrganizationSwitcher } from "./SideNavOrganizationSwitcher"
import { SideNavTooltip } from "./SideNavTooltip"

type SideNavOrganizationButtonProps = {
  expanded: boolean
  routeOrgSlug: string | null
  onSelectOrg: (orgSlug: string) => void
}

export function SideNavOrganizationButton({
  expanded,
  routeOrgSlug,
  onSelectOrg,
}: SideNavOrganizationButtonProps) {
  const router = useRouter()
  const [, setPreferences] = useUserPreferences()

  return (
    <SideNavTooltip label="Organization" enabled={!expanded}>
      <div className="w-full">
        <SideNavOrganizationSwitcher
          expanded={expanded}
          routeOrgSlug={routeOrgSlug}
          onSetActive={(org) => {
            onSelectOrg(org.slug)
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
      </div>
    </SideNavTooltip>
  )
}
