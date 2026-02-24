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
          base: [
            "mt-1 flex h-10 w-full items-center rounded-md border border-transparent px-0.5 text-zinc-300 transition-colors",
            "hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100",
          ].join(" "),
          avatar: {
            base: "border border-zinc-700/80 bg-zinc-900",
          },
          user: {
            base: [
              "truncate whitespace-nowrap text-[13px] transition-all duration-200",
              expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
            ].join(" "),
          },
        },
        content: {
          base: "border border-zinc-800 bg-zinc-900 text-zinc-100 shadow-2xl shadow-black/40",
          menuItem: "hover:bg-zinc-800 focus:bg-zinc-800",
          separator: "bg-zinc-700",
        },
      }}
    />
  )
}
