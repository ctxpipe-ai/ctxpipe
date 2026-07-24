import { HttpResponse, http } from "msw"

/** MSW handler for `GET .../connector-bootstrap` (used in Storybook). */
export function githubConnectorBootstrapHandler(input: {
  orgSlug: string
  hostedDefaultAppInstallUrl: string | null
  githubAppConfiguredInEnv?: boolean
  rowsNeedingSecrets?: number
}) {
  const {
    orgSlug,
    hostedDefaultAppInstallUrl,
    githubAppConfiguredInEnv = Boolean(hostedDefaultAppInstallUrl),
    rowsNeedingSecrets = 0,
  } = input
  const origin = `https://${orgSlug}.example.com`
  return http.get(
    ({ request }) => {
      const p = new URL(request.url).pathname
      return p === `/${orgSlug}/api/v1/github/installation/connector-bootstrap`
    },
    () =>
      HttpResponse.json({
        publicApiOrigin: origin,
        suggestedWebhookUrlTemplate: `${origin}/api/v1/webhook/github/<connectionId>`,
        githubAppConfiguredInEnv,
        rowsNeedingSecrets,
        hostedDefaultAppInstallUrl,
      }),
  )
}
