"use client"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/Button"
import {
  Disclosure,
  DisclosureHeader,
  DisclosurePanel,
} from "@/components/ui/Disclosure"
import { authClient } from "@/lib/auth-client"
import {
  atlassianConnectorKeys,
  fetchOrgAtlassianOauth,
} from "../../../queries/atlassian-connector"
import { AtlassianOauthAppSavedSection } from "../../AtlassianOauthAppSavedSection"

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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Link Atlassian account
        </h3>
        {useGlobalOauth ? (
          <p className="mt-2 text-sm text-zinc-400">
            This deployment uses a single Atlassian OAuth app from its server
            configuration. Connect your account — use the same account you will
            use in the Confluence/Forge install flow.
          </p>
        ) : meta.data?.oauthAppSaved ? (
          <p className="mt-2 text-sm text-zinc-400">
            The 3LO app is configured for this connection. Change credentials if
            needed, then connect the Atlassian account you will use for
            Confluence/Forge.
          </p>
        ) : (
          <p className="mt-2 text-sm text-amber-400/90">
            If you haven&apos;t saved your OAuth credentials yet, go back to{" "}
            <strong className="font-medium text-zinc-200">
              Register Atlassian OAuth app
            </strong>{" "}
            first. Otherwise reload this step after saving.
          </p>
        )}
      </div>
      {meta.isPending ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : null}
      {meta.isError ? (
        <p className="text-sm text-red-400">
          Could not load org OAuth settings.
        </p>
      ) : null}
      {meta.data && useGlobalOauth ? (
        <div className="space-y-3">
          <Button
            variant="primary"
            isPending={meta.isPending}
            onPress={async () => {
              await authClient.linkSocial({
                provider: "atlassian",
                callbackURL: window.location.pathname,
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
            onPress={() => {
              const returnTo = `${window.location.pathname}${window.location.search}`
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
