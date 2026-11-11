import pg from "pg"

/*
 * Synthetic rows in each table of a migrated database, for the cutover
 * rehearsal and the copy test (CTX-1217). No row holds customer data: each
 * value comes from the row number. The rows follow a shape: the row count
 * and the size of each table, for example from the shape query on production
 * (`cutoverRehearsal.ts --print-shape-query`), which reads only table names,
 * row estimates and sizes.
 *
 * Each value is a function of its table, its column and the row number, so a
 * foreign key can name the value of the row that it refers to. The restore
 * checks each foreign key, so the rows must keep them. Run it as a
 * superuser: it turns off the foreign-key triggers of its session
 * (`session_replication_role = replica`), so the tables fill in any order.
 */

export type TableShape = { rows: number; bytes?: number }

type FillResult = { table: string; rows: number; error?: string }

type Column = {
  table: string
  name: string
  type: string
  typtype: string
  category: string
  dims: number | null
  notNull: boolean
  /** A default, an identity or a generated value: the server fills it. */
  serverValue: boolean
  identity: boolean
  generated: boolean
  /** A check on this column only, for example a list of allowed values. */
  check: string | null
  /** In a check of more columns ("one of"), and not its first nullable one. */
  nullInCheck: boolean
  /** The first foreign key of the column: the column that it refers to. */
  refTable: string | null
  refColumn: string | null
  /** Another table's foreign key refers to this column. */
  referenced: boolean
  /** In an index, for example a primary key. */
  indexed: boolean
}

type Table = {
  name: string
  rows: number
  /** The size of one row in the shape. */
  rowBytes: number
  columns: Column[]
}

const BATCH = 200_000

async function readColumns(client: pg.Client): Promise<Column[]> {
  const { rows } = await client.query<Column>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "table", a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type, t.typtype, t.typcategory AS category,
            CASE WHEN t.typname = 'vector' AND a.atttypmod > 0 THEN a.atttypmod END AS dims,
            a.attnotnull AS "notNull",
            (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS "serverValue",
            a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated,
            (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
              WHERE k.conrelid = a.attrelid AND k.contype = 'c' AND k.conkey = ARRAY[a.attnum]
              LIMIT 1) AS "check",
            EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.conrelid = a.attrelid AND k.contype = 'c' AND cardinality(k.conkey) > 1
                AND a.attnum = ANY (k.conkey) AND NOT a.attnotnull
                AND a.attnum > (SELECT min(b.attnum) FROM pg_attribute b
                  WHERE b.attrelid = a.attrelid AND b.attnum = ANY (k.conkey) AND NOT b.attnotnull)
            ) AS "nullInCheck",
            f."refTable", f."refColumn",
            EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.confrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY (k.confkey)
            ) AS referenced,
            EXISTS (SELECT 1 FROM pg_index i
              WHERE i.indrelid = a.attrelid AND a.attnum = ANY (i.indkey)
            ) AS indexed
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN LATERAL (
       SELECT format('%I.%I', rn.nspname, rc.relname) AS "refTable", ra.attname AS "refColumn"
       FROM pg_constraint k
       CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS pair(attnum, refnum)
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = pair.refnum
       WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND pair.attnum = a.attnum
       ORDER BY k.conname LIMIT 1
     ) f ON true
     WHERE c.relkind = 'r' AND n.nspname IN ('public', 'openworkflow')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, a.attnum`,
  )
  return rows
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** True when the generator writes the column; false when the server fills it. */
function written(column: Column): boolean {
  if (column.generated) return false
  return !column.serverValue || column.referenced
}

/**
 * True for a column that holds the bulk of a row: text with no length
 * limit, JSON or bytea, with no key, no foreign key, no index and no check.
 * Its value gets `pad` different md5 strings, so that the size of the table
 * follows the shape and compression does not make it smaller. A key gets
 * none, so a foreign key needs no padding to match it.
 */
function payload(column: Column): boolean {
  if (!written(column) || column.indexed || column.referenced) return false
  if (column.refTable || column.check || column.nullInCheck) return false
  if (["text", "json", "jsonb", "bytea"].includes(column.type)) return true
  return column.type === "character varying"
}

/** `pad` different md5 strings of row `g`, in one hex string. */
function padding(column: Column, g: string, pad: number): string {
  return `(SELECT string_agg(md5((${g})::text || ':' || k::text || ${literal(column.name)}), '') FROM generate_series(1, ${pad}) AS k)`
}

/**
 * A SQL expression for one column of row `g` (a SQL expression for the row
 * number). The value of a row depends only on the table, the column and
 * the row number, so a foreign key can name the value of another row.
 */
function value(
  column: Column,
  g: string,
  tables: Map<string, Table>,
  pad: number,
): string {
  const { type } = column
  if (column.nullInCheck) return `NULL::${type}`
  if (column.refTable && column.refColumn) {
    const target = tables.get(column.refTable)
    const ref = target?.columns.find((other) => other.name === column.refColumn)
    // A nullable foreign key stays empty, unless a check needs a value in it.
    if (!column.notNull && !column.check) return `NULL::${type}`
    if (target && ref && target.rows > 0)
      return `(${value(ref, `((${g} - 1) % ${target.rows} + 1)`, tables, 0)})::${type}`
  }
  // A check such as `status = ANY (ARRAY['a'::text, …])` allows only listed
  // values: use the first one.
  const allowed = column.check
    ? /ARRAY\['((?:[^']|'')*)'::/.exec(column.check)?.[1]
    : undefined
  if (allowed !== undefined) return `${literal(allowed)}::${type}`
  const padded = pad > 0 && payload(column)
  const text = `${literal(`${column.table}.${column.name}:`)} || (${g})${padded ? ` || ':' || ${padding(column, g, pad)}` : ""}`
  if (column.typtype === "e")
    return `(enum_range(NULL::${type}))[1 + (${g}) % array_length(enum_range(NULL::${type}), 1)]`
  if (column.category === "A") return `'{}'::${type}`
  if (type === "uuid") return `md5(${literal(column.table)} || (${g}))::uuid`
  if (type === "boolean") return `(${g}) % 2 = 0`
  if (type === "smallint") return `((${g}) % 32000)::smallint`
  // A hex digit is half a byte: twice the md5 strings give the same size.
  if (type === "bytea")
    return `decode(md5((${g})::text)${padded ? ` || ${padding(column, g, pad * 2)}` : ""}, 'hex')`
  if (type === "json" || type === "jsonb")
    return padded
      ? `jsonb_build_object('n', ${g}, 'pad', ${padding(column, g, pad)})::${type}`
      : `jsonb_build_object('n', ${g})::${type}`
  if (type.startsWith("vector"))
    return `array_fill(((${g}) % 1000)::real / 1000, ARRAY[${column.dims ?? 3}])::${type}`
  if (type === "interval") return `(${g}) * interval '1 second'`
  if (column.category === "D")
    return `(timestamptz '2026-01-01 00:00:00+00' + (${g}) * interval '1 second')::${type}`
  if (/^numeric\(\d+,\d+\)$/.test(type)) return `((${g}) % 10)::${type}`
  if (column.category === "N") return `(${g})::${type}`
  if (column.category === "S") {
    const length = /\((\d+)\)$/.exec(type)?.[1]
    return length ? `left(${text}, ${length})::${type}` : `(${text})::${type}`
  }
  if (!column.notNull) return `NULL::${type}`
  throw new Error(`no synthetic value for ${column.name} ${type}`)
}

/**
 * Fills each table of `public` and `openworkflow` with synthetic rows. A table
 * that is not in `shape` gets `defaultRows`. A table that refuses the rows
 * (a check or a unique index that the generator does not know) has `error`
 * in its result, and the other tables continue. A table that has rows after
 * migrate (its bookkeeping) keeps them and gets no more.
 */
export async function fillSyntheticRows(
  superUrl: string,
  shape: Record<string, TableShape>,
  defaultRows: number,
  onTable?: (result: FillResult) => void,
): Promise<FillResult[]> {
  /** The length of one md5 string in hex. */
  const MD5_HEX_LENGTH = 32
  /** The size of one row when the shape gives no size. */
  const DEFAULT_ROW_BYTES = 200
  const client = new pg.Client({ connectionString: superUrl })
  await client.connect()
  try {
    await client.query("SET session_replication_role = replica")
    const tables = new Map<string, Table>()
    for (const column of await readColumns(client)) {
      let table = tables.get(column.table)
      if (!table) {
        const kept =
          ((await client.query(`SELECT 1 FROM ${column.table} LIMIT 1`))
            .rowCount ?? 0) > 0
        const target = shape[column.table] ?? { rows: defaultRows }
        table = {
          name: column.table,
          rows: kept ? 0 : target.rows,
          rowBytes:
            target.bytes && target.rows
              ? target.bytes / target.rows
              : DEFAULT_ROW_BYTES,
          columns: [],
        }
        tables.set(column.table, table)
      }
      table.columns.push(column)
    }
    const results: FillResult[] = []
    for (const table of tables.values()) {
      const result: FillResult = { table: table.name, rows: 0 }
      try {
        const list = table.columns.filter(written)
        const names = list.map((column) => `"${column.name}"`).join(", ")
        // The payload columns share the part of the row size of the shape
        // that the other columns (for example an embedding) do not fill.
        const payloads = list.filter(payload).length
        let pad = 0
        if (payloads > 0) {
          const sample = await client.query<{ bytes: number }>(
            `SELECT pg_column_size(ROW(${list.map((column) => value(column, "g", tables, 0)).join(", ")})) AS bytes FROM generate_series(1, 1) AS g`,
          )
          const fixed = sample.rows[0]?.bytes ?? 0
          pad = Math.max(
            0,
            Math.round((table.rowBytes - fixed) / payloads / MD5_HEX_LENGTH),
          )
        }
        const values = list
          .map((column) => value(column, "g", tables, pad))
          .join(", ")
        const overriding = list.some((column) => column.identity)
          ? " OVERRIDING SYSTEM VALUE"
          : ""
        for (let start = 1; start <= table.rows; start += BATCH) {
          const end = Math.min(table.rows, start + BATCH - 1)
          await client.query(
            list.length > 0
              ? `INSERT INTO ${table.name} (${names})${overriding} SELECT ${values} FROM generate_series(${start}, ${end}) AS g`
              : `INSERT INTO ${table.name} SELECT FROM generate_series(${start}, ${end}) AS g`,
          )
          result.rows = end
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      results.push(result)
      onTable?.(result)
    }
    return results
  } finally {
    await client.end()
  }
}
