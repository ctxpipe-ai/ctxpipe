import { once } from "node:events"
import { connect, createServer, type Socket } from "node:net"

/** A transparent local PostgreSQL proxy that drops one committed native INSERT reply. */
export async function withLostNativeWorkflowInsertAck<T>(
  databaseUrl: string,
  workflowName: string,
  run: (databaseUrl: string) => Promise<T>,
  mode: "returned-row" | "disconnect" = "returned-row",
): Promise<{ result: T; lostAcknowledgement: boolean }> {
  return withPostgresReplyFault(
    databaseUrl,
    { kind: "insert", workflowName, mode },
    run,
  )
}

/** Hold the actual COMMIT reply so a test can kill the writer after SQL persistence. */
export async function withHeldSemanticHandoffCommit<T>(
  databaseUrl: string,
  jobId: string,
  run: (databaseUrl: string, committed: Promise<void>) => Promise<T>,
) {
  return withPostgresReplyFault(
    databaseUrl,
    { kind: "semantic-handoff", jobId },
    run,
  )
}

async function withPostgresReplyFault<T>(
  databaseUrl: string,
  fault:
    | {
        kind: "insert"
        workflowName: string
        mode: "returned-row" | "disconnect"
      }
    | { kind: "semantic-handoff"; jobId: string },
  run: (databaseUrl: string, committed: Promise<void>) => Promise<T>,
): Promise<{ result: T; lostAcknowledgement: boolean }> {
  let signalCommit!: () => void
  const committed = new Promise<void>((resolve) => {
    signalCommit = resolve
  })
  const target = new URL(databaseUrl)
  let lostAcknowledgement = false
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || "5432"), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => {
        client.destroy()
        upstream.destroy()
      })
    }
    client.on("close", () => upstream.destroy())
    upstream.on("close", () => client.destroy())
    let startup = true
    let input = Buffer.alloc(0)
    let output = Buffer.alloc(0)
    const statements = new Set<string>()
    let discard = false
    let inserted = false
    let holdingCommit = false
    let withheld: Buffer[] = []
    client.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk])
      while (input.length >= (startup ? 4 : 5)) {
        const length = startup ? input.readInt32BE(0) : input.readInt32BE(1) + 1
        if (length < 4 || length > 16 * 1024 * 1024) {
          client.destroy()
          upstream.destroy()
          return
        }
        if (input.length < length) return
        const frame = input.subarray(0, length)
        input = input.subarray(length)
        if (startup) startup = false
        else if (frame[0] === 80) {
          // Parse: statement name, then SQL.
          const nameEnd = frame.indexOf(0, 5)
          const statement = frame.toString("utf8", 5, nameEnd)
          const query = frame.toString("utf8", nameEnd + 1)
          if (
            (fault.kind === "insert"
              ? /INSERT INTO\s+"openworkflow"\."workflow_runs"/i
              : /UPDATE\s+"workspace_write_jobs"/i
            ).test(query)
          )
            statements.add(statement)
          else statements.delete(statement)
        } else if (frame[0] === 66 && !lostAcknowledgement) {
          // Bind: portal, statement, parameters.
          const portalEnd = frame.indexOf(0, 5)
          const statementEnd = frame.indexOf(0, portalEnd + 1)
          const statement = frame.toString("utf8", portalEnd + 1, statementEnd)
          if (
            statements.has(statement) &&
            (fault.kind === "insert"
              ? frame.includes(Buffer.from(fault.workflowName))
              : frame.includes(Buffer.from(fault.jobId)) &&
                frame.includes(Buffer.from('"semanticHandoff"')))
          )
            discard = true
        }
        upstream.write(frame)
      }
    })
    upstream.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk])
      while (output.length >= 5) {
        const length = output.readInt32BE(1) + 1
        if (length < 5 || length > 32 * 1024 * 1024) {
          client.destroy()
          upstream.destroy()
          return
        }
        if (output.length < length) return
        const frame = output.subarray(0, length)
        output = output.subarray(length)
        if (!discard) {
          client.write(frame)
          continue
        }
        if (fault.kind === "semantic-handoff") {
          const command = frame[0] === 67 ? frame.toString("utf8", 5) : ""
          if (command.startsWith("UPDATE 1")) inserted = true
          if (inserted && command.startsWith("COMMIT")) holdingCommit = true
          if (holdingCommit) {
            if (frame[0] === 90 && frame[5] === 73 && !lostAcknowledgement) {
              lostAcknowledgement = true
              signalCommit()
            }
            continue
          }
          // UPDATE must be acknowledged before the client can issue COMMIT.
          client.write(frame)
          if (frame[0] === 90 && frame[5] === 73) {
            discard = false
            inserted = false
          }
          continue
        }
        withheld.push(frame)
        if (
          frame[0] === 67 &&
          frame.toString("utf8", 5).startsWith("INSERT 0 1")
        )
          inserted = true
        if (frame[0] !== 90) continue // ReadyForQuery follows the actual commit.
        if (inserted && frame[5] === 73) {
          lostAcknowledgement = true
          if (fault.mode === "disconnect") {
            client.destroy()
            upstream.destroy()
            return
          }
          // Lose the returned native run row while forwarding PostgreSQL
          // completion frames, so the actual committed connection stays usable.
          for (const pending of withheld) {
            if (pending[0] !== 68) client.write(pending)
          }
          withheld = []
          discard = false
          inserted = false
          continue
        }
        for (const pending of withheld) client.write(pending)
        withheld = []
        discard = false
      }
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("PostgreSQL proxy did not listen")
  const proxied = new URL(databaseUrl)
  proxied.hostname = "127.0.0.1"
  proxied.port = String(address.port)
  proxied.searchParams.set("sslmode", "disable")
  try {
    return {
      result: await run(proxied.toString(), committed),
      lostAcknowledgement,
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
