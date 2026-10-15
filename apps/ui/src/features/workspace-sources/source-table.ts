/**
 * The columns of the Workspace sources table: Source, Connection, Key,
 * Status, and actions. The table is a container query on the Sources
 * section. Below 48rem a row folds: the title, with the connection and key
 * under it, then the status and the actions at the right.
 *
 * A row has these cells in this order: the title, the meta wrapper (the
 * connection and key cells), the status, the actions, and an optional note.
 */
export const sourceRowClassName =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-2 hover:bg-foreground/[0.03] @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_9.5rem_4.5rem] @3xl:gap-x-4"

/** The column header row. It shows only when the table has columns. */
export const sourceTableHeadClassName =
  "hidden border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground @3xl:grid @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.8fr)_9.5rem_4.5rem] @3xl:gap-x-4"

/**
 * The connection and key cells. Folded, they are one line under the title.
 * With columns, the wrapper drops out and each cell takes its own column.
 * Always give it two children, so that the status stays in its column.
 */
export const sourceRowMetaClassName =
  "col-start-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground @3xl:contents"

/** A " · " between the connection and key. Only the folded row shows it. */
export const sourceRowSeparatorClassName = "@3xl:hidden"

export const sourceRowStatusClassName =
  "col-start-2 row-span-2 row-start-1 @3xl:col-start-auto @3xl:row-span-1 @3xl:row-start-auto"

export const sourceRowActionsClassName =
  "col-start-3 row-span-2 row-start-1 flex justify-end gap-1 @3xl:col-start-auto @3xl:row-span-1 @3xl:row-start-auto"

/** A detail line under the row, for example a status reason or a pending merge. */
export const sourceRowNoteClassName =
  "col-start-1 mt-0.5 text-xs @3xl:col-span-4"

/** The header row of one provider group. */
export const sourceGroupHeadClassName =
  "flex items-center gap-3 bg-white/[0.02] px-3 py-2"

/** The rows of one group, under its header row. */
export const sourceRowsClassName =
  "flex flex-col divide-y divide-white/[0.06] border-t border-white/[0.06]"
