import { AppShell } from "@/components/AppShell"
import { Button } from "@/components/ui/Button"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { usePreferredOrganization } from "@/lib/orgs"
import { useUserPreferences } from "@/lib/user-preferences"
import { OrganizationSwitcher } from "@daveyplate/better-auth-ui"
import { useMutation } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

export const Route = createFileRoute("/.github/setup")({
  component: DotGitHubSetupPage,
  validateSearch: (search: Record<string, unknown>) => ({
    installation_id:
      typeof search.installation_id === "number"
        ? search.installation_id
        : undefined,
    setup_action:
      typeof search.setup_action === "string" ? search.setup_action : undefined,
  }),
})

function DotGitHubSetupPage() {
  const { data: session, isPending } = useSession()
  const { targetOrganization } = usePreferredOrganization()
  const [, setPreferences] = useUserPreferences()
  const search = Route.useSearch()
  const navigate = useNavigate()

  const registerMutation = useMutation({
    mutationFn: async (orgSlug: string) => {
      if (!search.installation_id) throw new Error("Missing installation_id")
      const res = await client[":orgSlug"].api.v1.github.installation.$post({
        param: { orgSlug },
        json: { installationId: search.installation_id },
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(err.error ?? "Failed to register installation")
      }
      return orgSlug
    },
    onSuccess: (orgSlug) => {
      navigate({
        to: "/$orgSlug/github/setup",
        params: { orgSlug },
      })
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })

  if (isPending) return null
  if (!session) {
    const redirectTo = `/.github/setup${typeof window !== "undefined" ? window.location.search : ""}`
    return <Navigate to="/.auth/sign-in" search={{ redirectTo }} replace />
  }

  if (!search.installation_id) {
    return (
      <AppShell>
        <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
          <p className="text-red-400">
            Missing installation_id. Please complete the GitHub App installation
            from GitHub.
          </p>
        </main>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-md px-6 py-16 text-zinc-100">
        <h1 className="text-2xl font-semibold text-zinc-50">
          Link GitHub installation
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Choose which organization to connect this GitHub App installation to.
        </p>

        <div className="mt-8">
          {registerMutation.isPending ? (
            <p className="text-sm text-zinc-300">Registering installation…</p>
          ) : (
            <>
              <OrganizationSwitcher
                hidePersonal
                title="Select organization"
                onSetActive={(org) => {
                  if (!org) return
                  setPreferences((prev) => ({
                    ...prev,
                    selectedOrganizationSlug: org.slug,
                  }))
                }}
              />

              {targetOrganization && (
                <div className="mt-6 flex items-center gap-3">
                  <Button
                    variant="primary"
                    onPress={() =>
                      registerMutation.mutate(targetOrganization.slug)
                    }
                  >
                    Connect
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </AppShell>
  )
}
