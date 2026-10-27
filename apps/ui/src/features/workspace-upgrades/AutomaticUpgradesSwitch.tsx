import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId } from "react"
import { toast } from "sonner"

import { Switch } from "@/components/ui/Switch"

import {
  saveWorkspaceUpgradeModeAndWait,
  workspaceUpgradeKeys,
  workspaceUpgradeModeOptions,
} from "./queries"

/**
 * The automatic-upgrades setting of the Upgrades card (CTX-980), as a switch
 * with one line of help under it. Git holds the setting: the server reads it
 * on each request, and a save is a commit. The switch shows the new position
 * while the commit runs, then the saved setting. Only an owner or admin can
 * change it. When ctxpipe cannot read the setting, the line shows the cause
 * and the fix.
 */
export function AutomaticUpgradesSwitch(props: {
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
}) {
  const { orgSlug, workspaceSlug } = props
  const helpId = useId()
  const queryClient = useQueryClient()
  const modeOptions = workspaceUpgradeModeOptions(orgSlug, workspaceSlug)
  const setting = useQuery(modeOptions).data
  const save = useMutation({
    mutationFn: (next: "manual" | "automatic") =>
      saveWorkspaceUpgradeModeAndWait(
        queryClient,
        orgSlug,
        workspaceSlug,
        next,
      ),
    onSuccess: (result, next) => {
      if (result === "pending") {
        toast.message(
          "ctxpipe has not finished the save yet. Refresh the page later to see the setting.",
        )
        return
      }
      queryClient.setQueryData(modeOptions.queryKey, {
        mode: next,
        reason: null,
      })
      toast.success(
        next === "automatic"
          ? "Automatic upgrades are on. ctxpipe starts each upgrade by itself."
          : "Automatic upgrades are off. An owner or admin starts each upgrade.",
      )
    },
    onError: (error: Error, next) => {
      toast.error(
        `${error.message.replace(/\.$/, "")}. Turn automatic upgrades ${next === "automatic" ? "on" : "off"} again to try again.`,
      )
    },
    // With the setting on, the server starts the waiting upgrades. The
    // switch does not wait for this read.
    onSettled: (_result, _error, next) => {
      if (next === "automatic")
        void queryClient.invalidateQueries({
          queryKey: workspaceUpgradeKeys.list(orgSlug, workspaceSlug),
        })
    },
  })
  if (!setting) return null
  if (setting.mode === null) {
    const problem = {
      no_tip: "ctxpipe has not read the repository yet. Refresh the Workspace.",
      invalid_format:
        "the format file .ctxpipe/workspace.yaml is not valid. Fix it on the default branch.",
      unreadable:
        "ctxpipe could not read the repository. Check the GitHub connection on the Connectors page, then reload this page.",
    }[setting.reason ?? "unreadable"]
    return (
      <p className="max-w-prose text-xs text-muted-foreground">
        Automatic upgrades: {problem}
      </p>
    )
  }
  const on = save.isPending
    ? save.variables === "automatic"
    : setting.mode === "automatic"
  const canChange = props.isAdmin === true
  return (
    <div className="flex min-w-0 basis-[30rem] flex-col gap-1">
      <Switch
        isSelected={on}
        isDisabled={!canChange || save.isPending}
        onChange={(next) => save.mutate(next ? "automatic" : "manual")}
        aria-describedby={helpId}
      >
        Automatic upgrades
        {save.isPending ? (
          <span className="text-xs text-muted-foreground">Saving…</span>
        ) : null}
      </Switch>
      <p id={helpId} className="pl-9.5 text-xs text-muted-foreground">
        {on
          ? "ctxpipe starts each upgrade by itself, paid re-ingestions too. A failed upgrade waits for you."
          : canChange
            ? "You start each upgrade. Turn this on to let ctxpipe start them."
            : "An owner or admin starts each upgrade, and can turn this on."}
      </p>
    </div>
  )
}
