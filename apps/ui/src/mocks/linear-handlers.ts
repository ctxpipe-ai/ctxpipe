import { delay, HttpResponse, http } from "msw"
import type { LinearScope } from "@/features/connectors/queries/linear-connector"

/** The Linear teams and projects of the story Linear workspace. */
const linearStoryScopes: LinearScope[] = [
  {
    externalId: "team-eng",
    type: "team",
    title: "Engineering",
    teamId: "team-eng",
    teamKey: "ENG",
  },
  {
    externalId: "team-ops",
    type: "team",
    title: "Operations",
    teamId: "team-ops",
    teamKey: "OPS",
  },
  {
    externalId: "project-launch",
    type: "project",
    title: "Q3 launch",
    teamId: "team-eng",
    teamKey: "ENG",
  },
]

/** `GET …/connectors/linear/available-scopes`: the team and project picker. */
export function linearAvailableScopesHandler(
  response: LinearScope[] | "error" | "pending" = linearStoryScopes,
) {
  return http.get(
    /\/api\/v1\/connectors\/linear\/available-scopes(\?|$)/,
    async () => {
      if (response === "pending") await delay("infinite")
      if (response === "error")
        return HttpResponse.json({ error: "Linear is down" }, { status: 502 })
      return HttpResponse.json({ items: response })
    },
  )
}
