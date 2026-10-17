import { render } from "@react-email/render"
import { createTransport } from "nodemailer"
import type { ReactElement } from "react"
import { parseEnv } from "../config/env.js"
import { log } from "../observability/logger.js"

export async function sendEmail(
  to: string,
  subject: string,
  template: ReactElement,
): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)

  if (!env.SMTP_CONNECTION_URL || !env.EMAIL_FROM_ADDRESS) {
    const html = await render(template)
    const text = await render(template, { plainText: true })
    log.info({
      step: "email.dev_stub",
      message: "[email] SMTP not configured — would send (dev stub)",
      to,
      subject,
      textPreview: text.slice(0, 500),
      htmlPreview: html.slice(0, 500),
    })
    return
  }

  const transporter = createTransport(env.SMTP_CONNECTION_URL)
  const html = await render(template)
  const text = await render(template, { plainText: true })

  // Never log the recipient or the body: logs leave the process.
  try {
    const info = await transporter.sendMail({
      from: env.EMAIL_FROM_ADDRESS,
      to,
      subject,
      html,
      text,
    })
    log.info({
      step: "email.sent",
      message: "[email] SMTP server accepted the message",
      subject,
      messageId: info.messageId,
      accepted: info.accepted.length,
      rejected: info.rejected.length,
      response: info.response,
    })
  } catch (error) {
    log.error({
      step: "email.failed",
      message: "[email] SMTP send failed",
      subject,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
