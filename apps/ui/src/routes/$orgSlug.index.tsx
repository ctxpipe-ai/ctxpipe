import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { useEffect } from "react"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  const [preferences, updatePreferences] = useUserPreferences()

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  return (
    <AppShell>
      <section className="mx-auto flex min-h-[70vh] h-full max-w-5xl items-center justify-center">
        <div className="w-full rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-8 shadow-2xl shadow-black/30 backdrop-blur-sm sm:p-10">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
            ctxpipe ui
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
            Welcome back mate!!!!
          </h1>
          <p className="mt-4 max-w-2xl text-zinc-300">
            This shell is now ready for product pages. Use the navigation on the
            left to access account and settings views.
          </p>
        </div>
      </section>
    </AppShell>
  )
}
