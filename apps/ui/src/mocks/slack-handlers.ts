import { delay, HttpResponse, http } from "msw"
import type { SlackChannel } from "@/features/connectors/queries/slack-connector"

/** The channels of the story Slack team. Names and ids are made up. */
export const slackStoryChannels: SlackChannel[] = [
  { id: "C0ALL0001", name: "all-hands", isPrivate: false, isMember: false },
  { id: "C0ENG0001", name: "eng", isPrivate: false, isMember: true },
  { id: "C0DES0001", name: "eng-design", isPrivate: false, isMember: true },
  { id: "G0INC0001", name: "incidents", isPrivate: true, isMember: true },
]

export function slackChannelsHandler(
  response: SlackChannel[] | "error" | "pending" = slackStoryChannels,
  options: { truncated?: boolean } = {},
) {
  return http.get(/\/api\/v1\/connectors\/slack\/channels(\?|$)/, async () => {
    if (response === "pending") await delay("infinite")
    if (response === "error")
      return HttpResponse.json(
        { error: "Could not load the Slack channels" },
        { status: 502 },
      )
    return HttpResponse.json({
      items: response,
      truncated: options.truncated ?? false,
    })
  })
}
