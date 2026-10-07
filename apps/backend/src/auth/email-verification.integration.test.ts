import { createServer, type Server } from "node:net"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

type Mail = { to: string; subject: string; body: string }

const base = "http://localhost:3000"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const emails: string[] = []
const mails: Mail[] = []
let smtp: Server
let smtpPort = 0

function newEmail(): string {
  const email = `verify-${emails.length}-${suffix}@example.com`
  emails.push(email)
  return email
}

/** Just enough SMTP for nodemailer: accept every message and keep it. */
function receive(raw: string, to: string): Mail {
  const decoded = raw
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
  const subject = /^Subject: (.*)$/m.exec(decoded)?.[1] ?? ""
  return { to, subject, body: decoded.replaceAll("&amp;", "&") }
}

function startSmtp(): Promise<void> {
  smtp = createServer((socket) => {
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
          mails.push(receive(message + buffer.slice(0, end), to))
          buffer = buffer.slice(end + 5)
          message = null
          socket.write("250 OK\r\n")
          continue
        }
        const eol = buffer.indexOf("\r\n")
        if (eol === -1) return
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        const command = line.slice(0, 4).toUpperCase()
        if (command === "RCPT") to = /<([^>]+)>/.exec(line)?.[1] ?? ""
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
  return new Promise((resolve) =>
    smtp.listen(0, "127.0.0.1", () => {
      const address = smtp.address()
      smtpPort = typeof address === "object" && address ? address.port : 0
      resolve()
    }),
  )
}

function mailsTo(email: string): Mail[] {
  return mails.filter((mail) => mail.to === email)
}

function post(path: string, body: Record<string, unknown>, cookie?: string) {
  return getAuth().handler(
    new Request(`${base}/.auth/api/v1/auth${path}`, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

function signUp(email: string, password: string, callbackURL?: string) {
  return post("/sign-up/email", {
    name: "Verification test",
    email,
    password,
    ...(callbackURL ? { callbackURL } : {}),
  })
}

/** Mail is sent through SMTP, so email verification is required. */
function withSmtp() {
  vi.stubEnv("SMTP_CONNECTION_URL", `smtp://127.0.0.1:${smtpPort}`)
  resetBetterAuthForTests()
}

describeWithDatabase("email verification (Postgres)", () => {
  beforeAll(async () => {
    initDb(process.env.DATABASE_URL as string)
    await startSmtp()
  })

  beforeEach(() => {
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.com")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    withSmtp()
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    if (emails.length > 0) {
      await getSystemDb().delete(users).where(inArray(users.email, emails))
    }
    await closeDb()
    await new Promise((resolve) => smtp.close(resolve))
  })

  it("answers a sign-up with an unverified account's address with the account-exists email, not a link into that account", async () => {
    const email = newEmail()

    expect((await signUp(email, "first-registrant-password")).status).toBe(200)
    expect((await signUp(email, "address-owner-password")).status).toBe(200)

    expect(mailsTo(email).map((mail) => mail.subject)).toEqual([
      "Verify your email address",
      "You already have a ctx| account",
    ])
  })

  it("links the account-exists email's sign-in back to where the sign-up started", async () => {
    const email = newEmail()
    const invitation = `${base}/.auth/accept-invitation?invitationId=inv_test`

    await signUp(email, "first-password", invitation)
    await signUp(email, "second-password", invitation)

    expect(mailsTo(email).at(-1)?.body).toContain(
      `${base}/.auth/sign-in?redirectTo=${encodeURIComponent(invitation)}`,
    )
  })
})
