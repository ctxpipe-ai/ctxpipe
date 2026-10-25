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

  // In this SMTP branch, never log the recipient or the body. Logs leave the process.
  // An SMTP reply or a nodemailer error message can repeat the recipient, so log only its code fields.
  try {
    const info = await transporter.sendMail({
      from: { name: "ctxpipe", address: env.EMAIL_FROM_ADDRESS },
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
      response: info.response,
    })
  } catch (error) {
    const { code, responseCode, command } = error as {
      code?: string
      responseCode?: number
      command?: string
    }
    log.error({
      step: "email.failed",
      message: "[email] SMTP send failed",
      subject,
      code,
      responseCode,
      command,
    })
    // The nodemailer error holds the recipient. Callers only need to know that the send failed.
    throw new Error(`SMTP send failed (${code ?? "no code"})`)
  }
}
