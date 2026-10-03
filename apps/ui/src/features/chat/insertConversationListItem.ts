import type {
  ConversationListInfiniteData,
  ConversationListItem,
} from "./types"

export function insertConversationListItem(
  current: ConversationListInfiniteData | undefined,
  item: ConversationListItem,
): ConversationListInfiniteData {
  if (!current || current.pages.length === 0) {
    return {
      pages: [
        {
          items: [item],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: item.id,
            endCursor: item.id,
          },
        },
      ],
      pageParams: [undefined],
    }
  }
  if (current.pages.some((page) => page.items.some((row) => row.id === item.id))) {
    return current
  }
  const [first, ...rest] = current.pages
  if (!first) {
    return {
      ...current,
      pages: [{ items: [item], pageInfo: { hasNextPage: false, endCursor: item.id } }],
    }
  }
  return {
    ...current,
    pages: [
      {
        ...first,
        items: [item, ...first.items],
      },
      ...rest,
    ],
  }
}
