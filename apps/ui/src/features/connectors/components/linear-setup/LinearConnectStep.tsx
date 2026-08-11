"use client"

import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { fetchLinearOAuthStart } from "../../queries/linear-connector"

type LinearConnectStepProps = {
  orgSlug: string
}

export function LinearConnectStep({ orgSlug }: LinearConnectStepProps) {
  const connectMutation = useMutation({
    mutationFn: () => fetchLinearOAuthStart(orgSlug),
    onSuccess: ({ authorizationUrl }) => {
      const popup = window.open(
        authorizationUrl,
        "ctxpipe-linear-oauth",
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
          Connect Linear workspace
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Authorise read-only access to the Linear workspace you want ctxpipe to
          mirror. A new window will open for approval.
        </p>
      </div>
      <Button
        variant="primary"
        className="rounded-none"
        isPending={connectMutation.isPending}
        onPress={() => connectMutation.mutate()}
      >
        Connect Linear
      </Button>
    </div>
  )
}
