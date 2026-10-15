import { IconBrandSlack, IconLock } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineLoader } from "@/components/ui/InlineLoader"
import { SearchField } from "@/components/ui/SearchField"
import {
  fetchSlackChannels,
  type SlackChannel,
  slackConnectorKeys,
} from "@/features/connectors/queries/slack-connector"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"

function initialChannels(scope: Record<string, unknown>): string[] {
  const channels = scope.channels
  return Array.isArray(channels)
    ? channels.filter((id): id is string => typeof id === "string")
    : []
}

/**
 * The rows of the picker: each selected channel that Slack no longer lists
 * (archived, or the bot left), so the user can remove it, then the channels
 * that the bot is in, then the others.
 */
function channelRows(
  listed: readonly SlackChannel[],
  selected: readonly string[],
): SlackChannel[] {
  const known = new Set(listed.map((channel) => channel.id))
  const missing = selected
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id, isPrivate: false, isMember: false }))
  return [
    ...missing,
    ...listed.filter((channel) => channel.isMember),
    ...listed.filter((channel) => !channel.isMember),
  ]
}

/** Pick the Slack channels whose captured threads go to one Workspace. */
export function SlackScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [selected, setSelected] = useState(() => initialChannels(initialScope))
  const [search, setSearch] = useState("")
  const channelsQuery = useQuery({
    queryKey: slackConnectorKeys.channels(orgSlug, connectionId),
    queryFn: () => fetchSlackChannels(orgSlug, connectionId),
  })
  const pickerLabel = label ? `Slack channels for ${label}` : "Slack channels"
  const update = (next: string[]) => {
    setSelected(next)
    onChange(next.length ? { channels: next } : null)
  }

  if (channelsQuery.isPending)
    return <InlineLoader label="Loading Slack channels" />
  if (channelsQuery.isError)
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">Could not load the Slack channels.</p>
        <Button
          variant="secondary"
          className="rounded-md"
          onPress={() => void channelsQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    )

  const { items: channels, truncated } = channelsQuery.data
  const listedIds = new Set(channels.map((channel) => channel.id))
  const query = search.trim().replace(/^#/, "").toLowerCase()
  const rows = channelRows(channels, selected).filter(
    (channel) => !query || channel.name.toLowerCase().includes(query),
  )
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-foreground">{pickerLabel}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Mention the ctx| bot in a thread of a selected channel to save that
          thread. Private channels show only when the bot is in them.
        </p>
      </div>
      {truncated ? (
        <p className="text-sm text-muted-foreground">
          Showing the first 2000 channels. Search finds channels in this list
          only.
        </p>
      ) : null}
      <SearchField
        aria-label={`Search ${pickerLabel}`}
        placeholder="Search channels"
        value={search}
        onChange={setSearch}
      />
      <CheckboxGroup
        aria-label={pickerLabel}
        value={selected}
        onChange={update}
        className="max-h-[min(48vh,28rem)] gap-0 overflow-y-auto border border-border"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No channel matches “{search}”.
          </p>
        ) : null}
        {rows.map((channel) => {
          const listed = listedIds.has(channel.id)
          const detail = !listed
            ? "Slack does not list this channel now. It is archived, or the ctx| bot left it."
            : channel.isMember
              ? null
              : "Invite the bot to this channel before you mention it there."
          return (
            <Checkbox
              key={channel.id}
              value={channel.id}
              className="w-full cursor-pointer items-start border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1 truncate text-foreground">
                  {channel.isPrivate ? (
                    <IconLock aria-label="Private" className="size-3.5" />
                  ) : (
                    <span aria-hidden>#</span>
                  )}
                  {channel.name}
                </span>
                {detail ? (
                  <span className="block text-xs text-muted-foreground">
                    {detail}
                  </span>
                ) : null}
              </span>
            </Checkbox>
          )
        })}
      </CheckboxGroup>
      <p className="text-sm text-muted-foreground">
        {selected.length
          ? `${selected.length} ${selected.length === 1 ? "channel" : "channels"} selected.`
          : "Select at least one channel."}
      </p>
    </div>
  )
}

export const slackSourceUi: SourceProviderUi = {
  Icon: IconBrandSlack,
  ScopeEditor: SlackScopeEditor,
}
