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
import { type FakeSmtp, startFakeSmtp } from "../test/fake-smtp.js"
import { sendEmail } from "./index.js"

const records: Record<string, unknown>[] = []
let smtp: FakeSmtp

const template = createElement("div", null, "Hello")

/** Every field and nested value of an error, as text. */
function everythingOf(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") return void parts.push(value)
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    if (value instanceof Error) parts.push(value.name, value.message)
    for (const key of Object.getOwnPropertyNames(value)) {
      parts.push(key)
      visit((value as Record<string, unknown>)[key])
    }
  }
  visit(error)
  return parts.join("\n")
}

beforeAll(async () => {
  smtp = await startFakeSmtp()
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
  smtp.refuse = false
  smtp.mails.length = 0
  records.length = 0
  vi.stubEnv("DATABASE_URL", "postgres://unused@localhost/unused")
  vi.stubEnv("AUTH_SECRET", "x".repeat(32))
  vi.stubEnv("SMTP_CONNECTION_URL", `smtp://127.0.0.1:${smtp.port}`)
  vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.com")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  await smtp.close()
})

it("logs what the SMTP server answered, without the recipient", async () => {
  await sendEmail("invitee@example.com", "Invitation", template)

  expect(smtp.mails).toMatchObject([
    { to: "invitee@example.com", subject: "Invitation" },
  ])
  const sent = records.find((record) => record.step === "email.sent")
  expect(sent).toMatchObject({
    level: "info",
    subject: "Invitation",
    response: expect.stringContaining("TEST123"),
  })
  expect(sent?.messageId).toEqual(expect.any(String))
  expect(JSON.stringify(records)).not.toContain("invitee@example.com")
})

it("logs a refusal and throws an error, and neither names the recipient", async () => {
  smtp.refuse = true

  const error = await sendEmail("invitee@example.com", "Invitation", template)
    .then(() => null)
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
  expect(everythingOf(error)).not.toContain("invitee")
  expect(
    records.find((record) => record.step === "email.failed"),
  ).toMatchObject({
    level: "error",
    subject: "Invitation",
    code: "EENVELOPE",
    responseCode: 550,
    command: "RCPT TO",
  })
  expect(records.some((record) => record.step === "email.sent")).toBe(false)
  expect(JSON.stringify(records)).not.toContain("invitee")
})
