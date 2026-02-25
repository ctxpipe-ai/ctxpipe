import { OrganizationSwitcher } from "@daveyplate/better-auth-ui"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { IconBuilding, IconChevronDown } from "@tabler/icons-react"
import { authClient, useSession } from "@/lib/auth-client"

type SideNavOrgSwitcherProps = {
  expanded: boolean
}

export function SideNavOrgSwitcher({ expanded }: SideNavOrgSwitcherProps) {
  const router = useRouter()
  const { data: session } = useSession()
  const activeOrganizationId = session?.session?.activeOrganizationId

  const { data: organizations, isPending: orgsPending } = useQuery({
    queryKey: ["organization", "list"],
    queryFn: async () => {
      const { data } = await authClient.organization.list({})
      return data ?? []
    },
    enabled: !!session,
  })

  const activeOrg = organizations?.find((o) => o.id === activeOrganizationId)
  const label = activeOrg?.name ?? "Organization"

  const trigger = (
    <button
      type="button"
      title={expanded ? undefined : label}
      className="group flex h-10 w-full items-center rounded-md border border-transparent px-0 text-left text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100"
    >
      <span className="flex w-10 shrink-0 items-center justify-center text-zinc-400 group-hover:text-zinc-200">
        <IconBuilding className="h-5 w-5" aria-hidden="true" />
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-[13px] transition-all duration-200",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        {orgsPending ? "…" : label}
      </span>
      <span
        className={[
          "shrink-0 text-zinc-500 transition-all duration-200",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        <IconChevronDown className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  )

  return (
    <OrganizationSwitcher
      trigger={trigger}
      hidePersonal
      side="right"
      align="start"
      onSetActive={() => {
        void router.navigate({ to: "/", replace: true })
      }}
      classNames={{
        trigger: {
          base: "w-full",
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
