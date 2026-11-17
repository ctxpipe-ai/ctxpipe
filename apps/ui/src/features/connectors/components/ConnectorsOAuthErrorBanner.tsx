import { InlineAlert } from "@/components/ui/InlineAlert"

type ConnectorsOAuthErrorBannerProps = {
  title: string
  description: string
}

/** OAuth / link error shown at the top of the org Connectors page (search `error` + `error_description`). */
export function ConnectorsOAuthErrorBanner({
  title,
  description,
}: ConnectorsOAuthErrorBannerProps) {
  return (
    <div className="mb-6">
      <InlineAlert variant="error" title={title}>
        {description}
      </InlineAlert>
    </div>
  )
}
