import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return null
  }

  if (!session) {
    return <Navigate to="/sign-in" replace />
  }

  return (
    <AppShell>
      <section className="mx-auto flex min-h-[70vh] h-full max-w-5xl items-center justify-center">
        <div className="w-full rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-8 shadow-2xl shadow-black/30 backdrop-blur-sm sm:p-10">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
            ctxpipe ui
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
            Welcome back
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
