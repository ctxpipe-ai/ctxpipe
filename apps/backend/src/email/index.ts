import { render } from "@react-email/render"
import { log } from "evlog"
import { createTransport } from "nodemailer"
import type { ReactElement } from "react"
import { parseEnv } from "../config/env.js"

export async function sendEmail(
  to: string,
  subject: string,
  template: ReactElement,
): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const recipientDomain = to.split("@")[1] ?? "unknown"

  if (!env.SMTP_CONNECTION_URL || !env.EMAIL_FROM_ADDRESS) {
    log.warn({
      area: "email",
      action: "email_send_skipped",
      smtpConfigured: false,
      recipientDomain,
      subject,
    })
    return
  }

  const transporter = createTransport(env.SMTP_CONNECTION_URL)
  const html = await render(template)
  const text = await render(template, { plainText: true })

  await transporter.sendMail({
    from: env.EMAIL_FROM_ADDRESS,
    to,
    subject,
    html,
    text,
  })
  log.info({
    area: "email",
    action: "email_sent",
    recipientDomain,
    subject,
  })
}
