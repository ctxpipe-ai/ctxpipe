import { OrganizationSwitcher } from "@daveyplate/better-auth-ui"

type SideNavOrganizationButtonProps = {
  expanded: boolean
}

export function SideNavOrganizationButton({
  expanded,
}: SideNavOrganizationButtonProps) {
  return (
    <OrganizationSwitcher
      title={expanded ? "Organization switcher" : "Organization"}
      side="right"
      align="end"
      size={expanded ? "default" : "icon"}
      classNames={{
        trigger: {
          base: "flex w-full bg-transparent text-zinc-300 hover:bg-transparent hover:text-white hover:bg-teal-900/30 py-1.5 rounded-none",
        },
      }}
    />
  )
}
