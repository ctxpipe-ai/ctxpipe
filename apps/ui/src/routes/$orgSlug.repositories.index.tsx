import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/repositories/")({
  component: RepositoriesRemoved,
})

function RepositoriesRemoved() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted-foreground">Not Found</p>
      </div>
    </main>
  )
}
