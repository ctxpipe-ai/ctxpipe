export type ConnectorsOAuthErrorBannerProps = {
  title: string
  description: string
}

/** OAuth / link error shown at the top of the org Connectors page (search `error` + `error_description`). */
export function ConnectorsOAuthErrorBanner({
  title,
  description,
}: ConnectorsOAuthErrorBannerProps) {
  return (
    <div className="mb-6 rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-100">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-zinc-300">{description}</p>
    </div>
  )
}
