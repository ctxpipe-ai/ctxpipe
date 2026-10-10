"use client"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { authClient } from "@/lib/auth-client"
import {
  atlassianConnectorKeys,
  fetchOrgAtlassianOauth,
} from "../../../queries/atlassian-connector"
import { AtlassianOauthAppSavedSection } from "../../AtlassianOauthAppSavedSection"

/**
 * The account link leaves the page. The connectors page reads
 * `atlassianConnectionId` and opens the wizard again for this connection.
 */
export function atlassianLinkReturnPath(
  href: string,
  atlassianConnectionId: string,
): string {
  const back = new URL(href)
  back.searchParams.set("atlassianConnectionId", atlassianConnectionId)
  return `${back.pathname}${back.search}`
}

type LinkAtlassianStepProps = {
  orgSlug: string
  atlassianConnectionId: string
}

export function LinkAtlassianStep({
  orgSlug,
  atlassianConnectionId,
}: LinkAtlassianStepProps) {
  const meta = useQuery({
    queryKey: atlassianConnectorKeys.orgAtlassianOauth(
      orgSlug,
      atlassianConnectionId,
    ),
    queryFn: () => fetchOrgAtlassianOauth(orgSlug, atlassianConnectionId),
  })

  const useGlobalOauth = meta.data?.globalAtlassianOAuthConfigured === true

  const returnPath = () =>
    atlassianLinkReturnPath(window.location.href, atlassianConnectionId)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Link Atlassian account
        </h3>
        {useGlobalOauth ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This deployment uses a single Atlassian OAuth app from its server
            configuration. Connect your account — use the same account you will
            use in the Confluence/Forge install flow.
          </p>
        ) : meta.data?.oauthAppSaved ? (
          <p className="mt-2 text-sm text-muted-foreground">
            The 3LO app is configured for this connection. Change credentials if
            needed, then connect the Atlassian account you will use for
            Confluence/Forge.
          </p>
        ) : (
          <p className="mt-2 text-sm text-amber-500/90">
            If you haven&apos;t saved your OAuth credentials yet, go back to{" "}
            <strong className="font-medium text-foreground">
              Register Atlassian OAuth app
            </strong>{" "}
            first. Otherwise reload this step after saving.
          </p>
        )}
      </div>
      {meta.isPending ? <InlineLoader label="Loading Atlassian OAuth" /> : null}
      {meta.isError ? (
        <p className="text-sm text-destructive">
          Could not load org OAuth settings.
        </p>
      ) : null}
      {meta.data && useGlobalOauth ? (
        <div className="space-y-3">
          <Button
            variant="primary"
            className="rounded-md"
            isPending={meta.isPending}
            onPress={async () => {
              await authClient.linkSocial({
                provider: "atlassian",
                callbackURL: returnPath(),
              })
            }}
          >
            Connect Atlassian account
          </Button>
        </div>
      ) : null}
      {meta.data && !useGlobalOauth && meta.data.oauthAppSaved ? (
        <div className="space-y-4">
          <Disclosure defaultExpanded={false} className="w-full max-w-lg">
            <DisclosureHeader trailingPill="change">
              OAuth (3LO) app is configured
            </DisclosureHeader>
            <DisclosurePanel>
              <AtlassianOauthAppSavedSection
                embedded
                hideSavedHeading
                orgSlug={orgSlug}
                connectionId={atlassianConnectionId}
                savedClientId={meta.data.atlassianOAuthClientId ?? ""}
              />
            </DisclosurePanel>
          </Disclosure>
          <Button
            variant="primary"
            className="rounded-md"
            onPress={() => {
              const returnTo = returnPath()
              const u = new URL(
                `/${orgSlug}/api/v1/org/atlassian-oauth/authorize`,
                window.location.origin,
              )
              u.searchParams.set("connectionId", atlassianConnectionId)
              u.searchParams.set("returnTo", returnTo)
              window.location.assign(u.toString())
            }}
          >
            Connect Atlassian account
          </Button>
        </div>
      ) : null}
    </div>
  )
}
