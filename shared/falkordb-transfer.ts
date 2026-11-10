import { connect, type Socket } from "node:net"

/*
 * The FalkorDB part of the index copy of the AWS cutover (CTX-1217): the
 * graph counts of a server, and an RDB snapshot over the Redis replication
 * protocol (what `redis-cli --rdb` does). Codesearch runs it in the cutover
 * tools (`apps/codesearch/src/cutover/`). The backend contract test starts
 * real FalkorDB containers for it, because the codesearch test image has no
 * FalkorDB. This module imports only Node built-ins, so both apps (Node and
 * Bun) can import it.
 */

/** The versions and the graph counts of one FalkorDB server. */
export type GraphSnapshot = {
  redisVersion: string
  /** The `ver` of the `graph` module in `MODULE LIST`, for example 42007. */
  moduleVersion: number
  /** Each graph, sorted by name. */
  graphs: { name: string; nodes: number; edges: number }[]
}

type Reply = string | number | null | Error | Reply[]

/** A connection that reads lines and bytes from a socket in order. */
type Connection = {
  /** Sends a command and does not read the reply. */
  send: (...args: string[]) => void
  command: (...args: string[]) => Promise<Reply>
  line: () => Promise<string>
  /** The buffered bytes, then the next chunks of the socket. */
  chunks: () => AsyncGenerator<Buffer>
  close: () => void
}

/** Opens a connection and authenticates with the password of the URL. */
async function open(url: string): Promise<Connection> {
  const parsed = new URL(url)
  if (parsed.protocol !== "redis:")
    throw new Error("The FalkorDB URL must have the form redis://host:port")
  const socket: Socket = await new Promise((resolve, reject) => {
    const client = connect(
      Number(parsed.port || 6379),
      parsed.hostname.replace(/^\[|\]$/g, ""),
    )
    client.once("connect", () => resolve(client))
    client.once("error", reject)
  })
  const incoming = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  let buffer: Buffer = Buffer.alloc(0)
  const fill = async () => {
    const next = await incoming.next()
    if (next.done) throw new Error("FalkorDB closed the connection")
    buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value
  }
  const line = async () => {
    for (;;) {
      const end = buffer.indexOf("\r\n")
      if (end >= 0) {
        const text = buffer.subarray(0, end).toString()
        buffer = buffer.subarray(end + 2)
        return text
      }
      await fill()
    }
  }
  const take = async (length: number) => {
    while (buffer.length < length) await fill()
    const bytes = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return bytes
  }
  const reply = async (): Promise<Reply> => {
    const text = await line()
    const value = text.slice(1)
    switch (text[0]) {
      case "+":
        return value
      case "-":
        return new Error(value)
      case ":":
        return Number(value)
      case "$": {
        const length = Number(value)
        if (length < 0) return null
        return (await take(length + 2)).subarray(0, length).toString()
      }
      case "*": {
        const length = Number(value)
        if (length < 0) return null
        const items: Reply[] = []
        for (let index = 0; index < length; index++) items.push(await reply())
        return items
      }
      default:
        throw new Error(`Unexpected reply from FalkorDB: ${text.slice(0, 40)}`)
    }
  }
  const send = (...args: string[]) => {
    socket.write(
      `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`,
    )
  }
  const connection: Connection = {
    send,
    command: (...args) => {
      send(...args)
      return reply()
    },
    line,
    chunks: async function* () {
      if (buffer.length) {
        const first = buffer
        buffer = Buffer.alloc(0)
        yield first
      }
      for (;;) {
        const next = await incoming.next()
        if (next.done) return
        yield next.value
      }
    },
    close: () => socket.destroy(),
  }
  if (parsed.password) {
    const auth = await connection.command(
      "AUTH",
      ...(parsed.username ? [decodeURIComponent(parsed.username)] : []),
      decodeURIComponent(parsed.password),
    )
    if (auth instanceof Error) {
      connection.close()
      throw new Error(`FalkorDB refused the password: ${auth.message}`)
    }
  }
  return connection
}

function checked(reply: Reply, what: string): Reply {
  if (reply instanceof Error) throw new Error(`${what}: ${reply.message}`)
  return reply
}

/** The count in the first cell of a `GRAPH.RO_QUERY` result. */
async function count(
  connection: Connection,
  graph: string,
  query: string,
): Promise<number> {
  const result = checked(
    await connection.command("GRAPH.RO_QUERY", graph, query),
    `GRAPH.RO_QUERY ${graph}`,
  )
  const rows = Array.isArray(result) ? result[1] : undefined
  const cell = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : null
  if (typeof cell !== "number")
    throw new Error(`GRAPH.RO_QUERY ${graph} gave no count`)
  return cell
}

/** Reads the versions and the node and edge count of each graph. */
export async function readGraphSnapshot(url: string): Promise<GraphSnapshot> {
  const connection = await open(url)
  try {
    const info = String(
      checked(await connection.command("INFO", "server"), "INFO"),
    )
    const redisVersion = /^redis_version:(\S+)/m.exec(info)?.[1] ?? "unknown"
    const modules = checked(
      await connection.command("MODULE", "LIST"),
      "MODULE LIST",
    )
    let moduleVersion: number | undefined
    for (const module of Array.isArray(modules) ? modules : []) {
      if (!Array.isArray(module)) continue
      const fields = new Map<Reply, Reply>()
      for (let index = 0; index + 1 < module.length; index += 2)
        fields.set(module[index] as Reply, module[index + 1] as Reply)
      if (fields.get("name") === "graph")
        moduleVersion = Number(fields.get("ver"))
    }
    if (moduleVersion === undefined)
      throw new Error("The server has no graph module (not FalkorDB)")
    const names = checked(await connection.command("GRAPH.LIST"), "GRAPH.LIST")
    const graphs: GraphSnapshot["graphs"] = []
    for (const name of (Array.isArray(names) ? names : []).map(String).sort())
      graphs.push({
        name,
        nodes: await count(connection, name, "MATCH (n) RETURN count(n)"),
        edges: await count(
          connection,
          name,
          "MATCH ()-[r]->() RETURN count(r)",
        ),
      })
    return { redisVersion, moduleVersion, graphs }
  } finally {
    connection.close()
  }
}

/**
 * The differences between the snapshot of the export and a server: a graph
 * that one side does not have, a different node or edge count, and a module
 * version below the version of the export (an older module may not load the
 * RDB). An empty list means that the copy is complete.
 */
export function compareGraphSnapshots(
  expected: GraphSnapshot,
  actual: GraphSnapshot,
): string[] {
  const problems: string[] = []
  if (actual.moduleVersion < expected.moduleVersion)
    problems.push(
      `module version ${actual.moduleVersion} is below the source version ${expected.moduleVersion}`,
    )
  const found = new Map(actual.graphs.map((graph) => [graph.name, graph]))
  for (const graph of expected.graphs) {
    const other = found.get(graph.name)
    found.delete(graph.name)
    if (!other) problems.push(`graph ${graph.name} is missing`)
    else if (other.nodes !== graph.nodes || other.edges !== graph.edges)
      problems.push(
        `graph ${graph.name} has ${other.nodes} nodes and ${other.edges} edges, expected ${graph.nodes} and ${graph.edges}`,
      )
  }
  for (const name of found.keys())
    problems.push(`graph ${name} is not expected`)
  return problems
}

/**
 * An RDB snapshot of the server, as the server sends it to a replica. The
 * server forks to write it, so stop the writes first. Redis 7 and later send
 * only the RDB (`REPLCONF rdb-only`). A diskless transfer ends with a
 * 40-byte mark instead of a length.
 */
export async function* fetchRdb(url: string): AsyncGenerator<Buffer> {
  const connection = await open(url)
  try {
    // A server before Redis 7 does not know rdb-only. It then sends the
    // replication stream after the RDB, and the length or the mark ends the
    // read. With `capa eof`, the server can send the RDB without a disk copy.
    for (const capability of [
      ["rdb-only", "1"],
      ["capa", "eof"],
    ])
      await connection.command("REPLCONF", ...capability)
    connection.send("SYNC")
    // Before the transfer starts, the server sends a newline now and then.
    let header = ""
    while (!header) header = (await connection.line()).replace(/^\n+/, "")
    if (header.startsWith("-"))
      throw new Error(`FalkorDB refused SYNC: ${header.slice(1)}`)
    if (header.startsWith("$EOF:")) {
      const mark = Buffer.from(header.slice(5))
      let tail = Buffer.alloc(0)
      for await (const chunk of connection.chunks()) {
        const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
        const end = data.indexOf(mark)
        if (end >= 0) {
          if (end > 0) yield data.subarray(0, end)
          return
        }
        // Keep the last bytes: the mark can start in this chunk.
        const keep = Math.min(mark.length - 1, data.length)
        if (data.length > keep) yield data.subarray(0, data.length - keep)
        tail = Buffer.from(data.subarray(data.length - keep))
      }
      throw new Error("FalkorDB closed the connection before the RDB end mark")
    }
    if (!header.startsWith("$"))
      throw new Error(`Unexpected SYNC reply: ${header.slice(0, 40)}`)
    let left = Number(header.slice(1))
    if (!Number.isSafeInteger(left) || left < 0)
      throw new Error(`Unexpected SYNC length: ${header.slice(0, 40)}`)
    if (left === 0) return
    for await (const chunk of connection.chunks()) {
      if (chunk.length >= left) {
        yield chunk.subarray(0, left)
        return
      }
      left -= chunk.length
      yield chunk
    }
    throw new Error(
      `FalkorDB closed the connection ${left} bytes before the RDB end`,
    )
  } finally {
    connection.close()
  }
}
