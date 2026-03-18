import { render } from "@react-email/render"
import type { ReactElement } from "react"
import { createTransport } from "nodemailer"
import { parseEnv } from "../config/env.js"

export async function sendEmail(
  to: string,
  subject: string,
  template: ReactElement,
): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)

  if (!env.SMTP_CONNECTION_URL || !env.EMAIL_FROM_ADDRESS) {
    const html = await render(template)
    const text = await render(template, { plainText: true })
    console.log(
      `[email] SMTP not configured — would send to ${to}: ${subject}\n${text}\n${html}`,
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
