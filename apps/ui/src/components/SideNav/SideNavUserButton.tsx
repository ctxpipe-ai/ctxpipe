import { UserButton } from "@daveyplate/better-auth-ui"

type SideNavUserButtonProps = {
  expanded: boolean
}

export function SideNavUserButton({ expanded }: SideNavUserButtonProps) {
  return (
    <UserButton
      title={expanded ? "User menu" : "User"}
      side="right"
      align="end"
      size={expanded ? "default" : "icon"}
      classNames={{
        trigger: {
          base: "flex w-full bg-transparent text-zinc-300 hover:bg-transparent hover:text-white hover:bg-teal-900/30 py-1.5 !rounded-none !size-full",
        },
        content: {
          base: "!rounded-none",
          menuItem: "!rounded-none",
          separator: "!rounded-none",
        },
      }}
    />
  )
}
