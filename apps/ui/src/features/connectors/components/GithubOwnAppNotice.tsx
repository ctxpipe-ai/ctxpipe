import { Link } from "@/components/ui/Link"

/**
 * A deployment without a GitHub App client cannot ask GitHub whether the user
 * can access an installation of the deployment's App. The organization's own
 * App (the self-hosted wizard) is then the only way in.
 */
export function GithubOwnAppNotice({ orgSlug }: { orgSlug: string }) {
  return (
    <section>
      <h1 className="text-3xl font-medium tracking-tight text-foreground">
        Use your organization's own GitHub App
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        GitHub sign-in is not enabled on this deployment, so ctxpipe cannot
        confirm that you can access this installation. Add a GitHub connection
        with your organization's own GitHub App from Connectors instead.
      </p>
      <div className="mt-6">
        <Link href={`/${orgSlug}/connectors`} className="text-sm">
          Open Connectors
        </Link>
      </div>
    </section>
  )
}
