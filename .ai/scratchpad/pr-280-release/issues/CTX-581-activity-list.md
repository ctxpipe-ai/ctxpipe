# CTX-581: Home activity list (filters, pages, compact rows, commit line)

Status: done on `ui/ctx-581-activity-list` (not pushed).

## Backend

- `GET /{orgSlug}/api/v1/workspaces/{slug}/activity` and `GET /{orgSlug}/api/v1/activity` take the optional query params `author`, `since`, `until` (UTC days, inclusive), `cursor`, and `limit` (1 to 100). The response adds `authors` (the authors of the heatmap window, most active first) and `nextCursor`. The change is additive: without the new params, the response is the same as before.
- The cursor is the last row of the page (commit time, SHA, workspace id), base64url JSON. The order is newest first, then SHA, then workspace id, so the org list has one total order also when two workspaces hold the same commit.
- A bad cursor gives 400.
- New functions: `listWorkspaceCommitAuthors` and `commitListConditions` in `models/workspace-commits.ts`. The org read of CTX-580 is not changed.

## UI

- The view is in the URL search params of `/$orgSlug/`: `scope` (`*` or a workspace slug), `author`, `day`, `since`, `until`. A reload keeps them. The controls set the view in the press handler (`useUrgentValue`), then write the URL with `replace`.
- Author: a quiet menu of the authors of the window, with an initial avatar and the commit count. The API has no avatar URL, and the brief allows no schema change, so the avatar shows the first letter of the name.
- Date range: a quiet menu with Any time, Last 7, 30, and 90 days. It sends `since`. A custom range from the URL (`since` and `until`) shows as "Aug 1, 2026 – Aug 31, 2026". A calendar picker is not in this change: the RAC `RangeCalendar` starter needs `@internationalized/date` as a new dependency and a restyle.
- The heatmap day works together with the author and the range. One "Reset" clears the author, the day, and the range. A scope change clears the author and the day.
- Pages: "Load more" under the list, ten commits per page (`useInfiniteQuery`). Why not numbered pages: the list is a short feed under the heatmap, a keyset cursor has no page count, and new rows come under the old rows, so the rows that the user reads do not move.
- Row: `<avatar> <message> ... <time ago> <short hash>` on one line. The message truncates. The time ago has a tooltip with the full local date and time (focusable for the keyboard). The hash is monospace and links to the commit in a new tab with the external-link icon on hover and focus. The message is not a link (one link per row).
- Commit line: each row draws its own line segment over its full height and a node at its center, `aria-hidden`, with the `border`, `muted-foreground`, and `background` tokens. The segments touch from row to row at any row height, and a new page does not move the rows above.

## Tests

- Backend: `apps/backend/src/routes/v1/workspace-activity-list.integration.test.ts` (pages and filters on one workspace and on the org; bad cursor, limit, and day).
- Stories: `WorkspaceActivity.stories.tsx` (`DayFiltersRecent`, `AuthorFiltersRecent`, `DateRangeFiltersRecent`, `ResetClearsEveryFilter`, `LoadMorePages`, scope stories) and `WorkspaceRecentCommits.stories.tsx` (`OpensInNewTab`, `CompactRowTruncates`, `TimeTooltip`, `CommitLineAligns`, golden `RecentCommitsSkeletonMatches` with ten rows).
