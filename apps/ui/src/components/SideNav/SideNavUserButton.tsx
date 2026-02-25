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
            "mt-1 flex h-10 w-full items-center rounded-md border border-zinc-800/80 bg-zinc-900/95 px-2 py-1.5 text-zinc-100 transition-colors",
            "hover:border-zinc-700 hover:bg-zinc-800/95",
            expanded ? "gap-2" : "justify-center",
          ].join(" "),
          avatar: {
            base: "border border-zinc-700/80 bg-zinc-800 shrink-0",
          },
          user: {
            base: [
              "min-w-0 truncate whitespace-nowrap text-[13px] transition-all duration-200",
              expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
            ].join(" "),
            title: "font-medium text-zinc-100",
            subtitle: "text-zinc-400",
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
