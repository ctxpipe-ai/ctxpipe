import { describe, expect, it } from "vitest"
import { insertConversationListItem } from "./insertConversationListItem"

describe("insertConversationListItem", () => {
  it("inserts a compose row before RUN_FINISHED refetch data exists", () => {
    const next = insertConversationListItem(
      {
        pages: [
          {
            items: [{ id: "conv_old", name: "Old", source: "ui", lastMessageAt: "1" }],
            pageInfo: { hasNextPage: false, endCursor: "conv_old" },
          },
        ],
        pageParams: [undefined],
      },
      {
        id: "conv_new",
        name: "New conversation",
        source: "ui",
        lastMessageAt: "2",
      },
    )
    expect(next.pages[0]?.items.map((item) => item.id)).toEqual([
      "conv_new",
      "conv_old",
    ])
  })

  it("does not duplicate an already visible conversation", () => {
    const current = {
      pages: [
        {
          items: [
            {
              id: "conv_new",
              name: "New conversation",
              source: "ui",
              lastMessageAt: "2",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "conv_new" },
        },
      ],
      pageParams: [undefined],
    }
    expect(
      insertConversationListItem(current, {
        id: "conv_new",
        name: "Renamed",
        source: "ui",
        lastMessageAt: "3",
      }),
    ).toBe(current)
  })
})
