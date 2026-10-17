import { createServer, type Server } from "node:net"
import { initLogger } from "evlog"
import { createElement } from "react"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest"
import { sendEmail } from "./index.js"

const mails: { to: string; subject: string }[] = []
const records: Record<string, unknown>[] = []
let refuse = false
let smtp: Server
let smtpPort = 0

const template = createElement("div", null, "Hello")

/** Just enough SMTP for nodemailer: accept or refuse every recipient. */
function startSmtp(): Promise<void> {
  smtp = createServer((socket) => {
    let buffer = ""
    let inData = false
    let to = ""
    socket.write("220 localhost\r\n")
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n")
          if (end === -1) return
          const subject = /^Subject: (.*)$/m.exec(buffer.slice(0, end))?.[1]
          mails.push({ to, subject: subject ?? "" })
          buffer = buffer.slice(end + 5)
          inData = false
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
          if (refuse) {
            socket.write("550 5.1.1 Mailbox unavailable\r\n")
            continue
          }
        }
        if (command === "QUIT") return void socket.end("221 Bye\r\n")
        if (command === "DATA") {
          inData = true
          socket.write("354 Go ahead\r\n")
          continue
        }
        socket.write("250 OK\r\n")
      }
    })
  })
  return new Promise((resolve) =>
    smtp.listen(0, "127.0.0.1", () => {
      const address = smtp.address()
      smtpPort = typeof address === "object" && address ? address.port : 0
      resolve()
    }),
  )
}

beforeAll(async () => {
  await startSmtp()
  initLogger({
    env: { service: "ctxpipe-backend-test" },
    pretty: false,
    silent: true,
    drain: (ctx) => {
      const batch = Array.isArray(ctx) ? ctx : [ctx]
      for (const item of batch) {
        records.push(item.event as Record<string, unknown>)
      }
    },
  })
})

beforeEach(() => {
  refuse = false
  mails.length = 0
  records.length = 0
  vi.stubEnv("DATABASE_URL", "postgres://unused@localhost/unused")
  vi.stubEnv("AUTH_SECRET", "x".repeat(32))
  vi.stubEnv("SMTP_CONNECTION_URL", `smtp://127.0.0.1:${smtpPort}`)
  vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.com")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  await new Promise((resolve) => smtp.close(resolve))
})

it("logs what the SMTP server answered, without the recipient", async () => {
  await sendEmail("invitee@example.com", "Invitation", template)

  expect(mails).toEqual([{ to: "invitee@example.com", subject: "Invitation" }])
  const sent = records.find((record) => record.step === "email.sent")
  expect(sent).toMatchObject({
    level: "info",
    subject: "Invitation",
    accepted: 1,
    rejected: 0,
    response: expect.stringContaining("TEST123"),
  })
  expect(sent?.messageId).toEqual(expect.any(String))
  expect(JSON.stringify(records)).not.toContain("invitee@example.com")
})

it("logs a failure without the recipient and throws the error again", async () => {
  refuse = true

  await expect(
    sendEmail("invitee@example.com", "Invitation", template),
  ).rejects.toThrow()

  expect(
    records.find((record) => record.step === "email.failed"),
  ).toMatchObject({ level: "error", subject: "Invitation" })
  expect(records.some((record) => record.step === "email.sent")).toBe(false)
  expect(JSON.stringify(records)).not.toContain("invitee@example.com")
})
