import { render } from "@react-email/render"
import { createTransport } from "nodemailer"
import type { ReactElement } from "react"
import { parseEnv } from "../config/env.js"
import { logWideEvent } from "../observability/logger.js"

export async function sendEmail(
  to: string,
  subject: string,
  template: ReactElement,
): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)

  if (!env.SMTP_CONNECTION_URL || !env.EMAIL_FROM_ADDRESS) {
    const html = await render(template)
    const text = await render(template, { plainText: true })
    logWideEvent(
      "info",
      "[email] SMTP not configured — would send (dev stub)",
      {
        step: "email.dev_stub",
        to,
        subject,
        textPreview: text.slice(0, 500),
        htmlPreview: html.slice(0, 500),
      },
    )
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
}
