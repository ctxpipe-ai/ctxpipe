import { createServer } from "node:net"

export type FakeMail = { to: string; subject: string; body: string }

export type FakeSmtp = {
  /** Port on 127.0.0.1. */
  port: number
  /** Every message the server accepted. */
  mails: FakeMail[]
  /** While true, the server refuses each recipient with a 550 reply that repeats the address. */
  refuse: boolean
  close(): Promise<void>
}

function receive(raw: string, to: string): FakeMail {
  const decoded = raw
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
  const subject = /^Subject: (.*)$/m.exec(decoded)?.[1] ?? ""
  return { to, subject, body: decoded.replaceAll("&amp;", "&") }
}

/** Just enough SMTP for nodemailer: accept or refuse every recipient and keep each message. */
export async function startFakeSmtp(
  options: { refuse?: boolean } = {},
): Promise<FakeSmtp> {
  const fake: FakeSmtp = {
    port: 0,
    mails: [],
    refuse: options.refuse ?? false,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  const server = createServer((socket) => {
    let buffer = ""
    let message: string | null = null
    let to = ""
    socket.write("220 localhost\r\n")
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (;;) {
        if (message !== null) {
          const end = buffer.indexOf("\r\n.\r\n")
          if (end === -1) return
          fake.mails.push(receive(message + buffer.slice(0, end), to))
          buffer = buffer.slice(end + 5)
          message = null
          socket.write("250 2.0.0 Queued as TEST123\r\n")
          continue
        }
        const eol = buffer.indexOf("\r\n")
        if (eol === -1) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        const command = line.slice(0, 4).toUpperCase()
        if (command === "RCPT") {
          to = /<([^>]+)>/.exec(line)?.[1] ?? ""
          if (fake.refuse) {
            socket.write(`550 5.1.1 <${to}>: Recipient address rejected\r\n`)
            continue
          }
        }
        if (command === "QUIT") return void socket.end("221 Bye\r\n")
        if (command === "DATA") {
          message = ""
          socket.write("354 Go ahead\r\n")
          continue
        }
        socket.write("250 OK\r\n")
      }
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      fake.port = typeof address === "object" && address ? address.port : 0
      resolve()
    }),
  )
  return fake
}
