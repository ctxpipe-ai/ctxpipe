import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"

import {
  saveWorkspaceUpgradeModeAndWait,
  workspaceUpgradeKeys,
  workspaceUpgradeModeOptions,
} from "./queries"

/**
 * The automatic-upgrades setting of the Status group: "Automatic upgrades:
 * Off" with Turn on, or "On" with Turn off (CTX-980). Git holds the setting:
 * the server reads it on each request, and a save is a commit. The button
 * waits for the commit, then shows the new setting. Only an owner or admin
 * sees the button. When ctxpipe cannot read the setting, the line shows the
 * cause and the fix.
 */
export function AutomaticUpgradesToggle(props: {
  orgSlug: string
  workspaceSlug: string
  isAdmin: boolean | null
}) {
  const { orgSlug, workspaceSlug } = props
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
        `${error.message.replace(/\.$/, "")}. Press ${next === "automatic" ? "Turn on" : "Turn off"} to try again.`,
      )
    },
    // With the setting on, the server starts the waiting upgrades. The
    // button does not wait for this read.
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
      <>
        <span aria-hidden>·</span>
        <span>Automatic upgrades: {problem}</span>
      </>
    )
  }
  const on = setting.mode === "automatic"
  return (
    <>
      <span aria-hidden>·</span>
      <span>Automatic upgrades: {on ? "On" : "Off"}</span>
      {props.isAdmin === true ? (
        <Button
          variant="ghost"
          size="sm"
          isPending={save.isPending}
          onPress={() => save.mutate(on ? "manual" : "automatic")}
          aria-label={
            on ? "Turn off automatic upgrades" : "Turn on automatic upgrades"
          }
        >
          {on ? "Turn off" : "Turn on"}
        </Button>
      ) : null}
    </>
  )
}
