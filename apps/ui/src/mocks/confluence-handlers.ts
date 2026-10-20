import { HttpResponse, http } from "msw"

/** The Confluence spaces and pages of the made-up site. */
export const confluenceTreeHandlers = [
  http.get(/\/api\/v1\/connectors\/atlassian\/available-spaces$/, () =>
    HttpResponse.json({
      items: [
        { id: "s1", key: "ENG", name: "Engineering", type: "global" },
        { id: "s2", key: "OPS", name: "Operations", type: "global" },
      ],
    }),
  ),
  http.get(
    /\/api\/v1\/connectors\/atlassian\/available-spaces\/[^/]+\/pages$/,
    () =>
      HttpResponse.json({
        items: [
          { id: "101", title: "Runbooks", spaceId: "s2" },
          { id: "102", title: "On-call", spaceId: "s2" },
        ],
      }),
  ),
]
