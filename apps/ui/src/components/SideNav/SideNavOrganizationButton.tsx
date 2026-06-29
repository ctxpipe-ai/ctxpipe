import { OrganizationSwitcher } from "@daveyplate/better-auth-ui"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useEffect } from "react"
import { authClient } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

type SideNavOrganizationButtonProps = {
  expanded: boolean
}

function orgFromCreateResult(result: unknown): { slug: string } | null {
  if (!result || typeof result !== "object") return null
  if ("error" in result) {
    if (result.error) return null
    const data = "data" in result ? result.data : null
    return data &&
      typeof data === "object" &&
      "slug" in data &&
      typeof data.slug === "string"
      ? { slug: data.slug }
      : null
  }
  if ("slug" in result && typeof result.slug === "string") {
    return { slug: result.slug }
  }
  return null
}

export function SideNavOrganizationButton({
  expanded,
}: SideNavOrganizationButtonProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [, setPreferences] = useUserPreferences()

  useEffect(() => {
    const originalCreate = authClient.organization.create.bind(
      authClient.organization,
    )

    authClient.organization.create = async (input) => {
      const result = await originalCreate(input)
      const org = orgFromCreateResult(result)
      if (org) {
        await queryClient.invalidateQueries({
          queryKey: ["organizations"],
          refetchType: "active",
        })
        if (!window.location.pathname.startsWith("/onboarding")) {
          setPreferences((prev) => ({
            ...prev,
            selectedOrganizationSlug: org.slug,
          }))
          void router.navigate({
            to: "/$orgSlug/setup",
            params: { orgSlug: org.slug },
            replace: true,
          })
        }
      }
      return result
    }

    return () => {
      authClient.organization.create = originalCreate
    }
  }, [queryClient, router, setPreferences])

  return (
    <OrganizationSwitcher
      hidePersonal
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
  )
}
