import { useRouter } from "@tanstack/react-router"
import { useUserPreferences } from "@/lib/user-preferences"
import { SideNavOrganizationSwitcher } from "./SideNavOrganizationSwitcher"
import { SideNavTooltip } from "./SideNavTooltip"

type SideNavOrganizationButtonProps = {
  expanded: boolean
}

function orgSlugFromPathname(pathname: string): string | null {
  const firstSegment = pathname.split("/").filter(Boolean)[0]
  if (!firstSegment || firstSegment.startsWith(".")) return null
  return firstSegment
}

export function SideNavOrganizationButton({
  expanded,
}: SideNavOrganizationButtonProps) {
  const router = useRouter()
  const [, setPreferences] = useUserPreferences()
  const routeOrgSlug = orgSlugFromPathname(
    router.state?.location.pathname ?? "",
  )

  return (
    <SideNavTooltip label="Organization" enabled={!expanded}>
      <div className="w-full">
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
      </div>
    </SideNavTooltip>
  )
}
