"use client"

import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { fetchPagerdutyOAuthStart } from "../queries/pagerduty-connector"

type PagerdutyConnectStepProps = {
  orgSlug: string
  connectionId?: string
  revoked?: boolean
}

export function PagerdutyConnectStep({
  orgSlug,
  connectionId,
  revoked = false,
}: PagerdutyConnectStepProps) {
  const connectMutation = useMutation({
    mutationFn: () => fetchPagerdutyOAuthStart(orgSlug, connectionId),
    onSuccess: ({ authorizationUrl }) => {
      const popup = window.open(
        authorizationUrl,
        "ctxpipe-pagerduty-oauth",
        "popup,width=640,height=760",
      )
      if (!popup) {
        toast.error("Allow pop-ups for this site, then try again.")
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Connect PagerDuty account
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {revoked
            ? "PagerDuty authorization is revoked; reconnect the account."
            : "Authorise read-only access to the PagerDuty account you want ctxpipe to mirror. A new window will open for approval."}
        </p>
      </div>
      <Button
        variant="primary"
        className="rounded-none"
        isPending={connectMutation.isPending}
        onPress={() => connectMutation.mutate()}
      >
        Connect PagerDuty
      </Button>
    </div>
  )
}
