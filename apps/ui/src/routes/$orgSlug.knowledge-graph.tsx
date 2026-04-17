import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { KnowledgeGraphExplorer } from "@/features/knowledge-graph/KnowledgeGraphExplorer"
import { useSession } from "@/lib/auth-client"

export const Route = createFileRoute("/$orgSlug/knowledge-graph")({
  // Cosmograph resolves `@/cosmograph/style.module.css`, which Node SSR can't map.
  ssr: false,
  component: KnowledgeGraphPage,
})

function KnowledgeGraphPage() {
  const { orgSlug } = Route.useParams()
  const { data: session, isPending } = useSession()

  if (isPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as {
    id: string
    onboardingCompletedAt?: string | null
  }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" search={{ orgSlug }} replace />
  }

  return (
    <AppShell>
      <div className="relative isolate min-h-[100dvh] w-full min-w-0 overflow-hidden bg-[#09090b]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 opacity-70"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 45%, rgba(20, 184, 166, 0.06) 0%, rgba(20, 184, 166, 0.02) 45%, rgba(0,0,0,0) 80%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <KnowledgeGraphExplorer orgSlug={orgSlug} />
      </div>
    </AppShell>
  )
}
