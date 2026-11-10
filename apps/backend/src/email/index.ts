import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2"
import { render } from "@react-email/render"
import { createTransport } from "nodemailer"
import type { ReactElement } from "react"

import { parseEnv } from "../config/env.js"
import { log } from "../observability/logger.js"

type Mail = { to: string; subject: string; html: string; text: string }

export async function sendEmail(
  to: string,
  subject: string,
  template: ReactElement,
): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const html = await render(template)
  const text = await render(template, { plainText: true })

  const from = env.EMAIL_FROM_ADDRESS
  const mail = { to, subject, html, text }
  if (from && env.EMAIL_TRANSPORT === "ses") return sendWithSes(from, mail)
  if (from && env.SMTP_CONNECTION_URL)
    return sendWithSmtp(env.SMTP_CONNECTION_URL, from, mail)

  log.info({
    step: "email.dev_stub",
    message: "[email] email not configured — would send (dev stub)",
    to,
    subject,
    textPreview: text.slice(0, 500),
    htmlPreview: html.slice(0, 500),
  })
}

// In both transports, never log the recipient or the body. Logs leave the
// process. A provider reply or error message can repeat the recipient, so
// log only its code fields.

async function sendWithSes(from: string, mail: Mail): Promise<void> {
  // The SDK reads the region and the credentials (the task role) from the
  // process environment.
  const client = new SESv2Client({})
  try {
    const sent = await client.send(
      new SendEmailCommand({
        FromEmailAddress: `ctxpipe <${from}>`,
        Destination: { ToAddresses: [mail.to] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: mail.html, Charset: "UTF-8" },
              Text: { Data: mail.text, Charset: "UTF-8" },
            },
          },
        },
      }),
    )
    log.info({
      step: "email.sent",
      message: "[email] SES accepted the message",
      subject: mail.subject,
      messageId: sent.MessageId,
    })
  } catch (error) {
    const { name, $metadata } = error as {
      name?: string
      $metadata?: { httpStatusCode?: number; requestId?: string }
    }
    log.error({
      step: "email.failed",
      message: "[email] SES send failed",
      subject: mail.subject,
      code: name,
      responseCode: $metadata?.httpStatusCode,
      requestId: $metadata?.requestId,
    })
    // The SES error message can hold the recipient. Callers only need to
    // know that the send failed.
    throw new Error(`SES send failed (${name ?? "no code"})`)
  } finally {
    client.destroy()
  }
}

async function sendWithSmtp(
  connectionUrl: string,
  from: string,
  mail: Mail,
): Promise<void> {
  const transporter = createTransport(connectionUrl)
  try {
    const info = await transporter.sendMail({
      from: { name: "ctxpipe", address: from },
      ...mail,
    })
    log.info({
      step: "email.sent",
      message: "[email] SMTP server accepted the message",
      subject: mail.subject,
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
      subject: mail.subject,
      code,
      responseCode,
      command,
    })
    // The nodemailer error holds the recipient. Callers only need to know that the send failed.
    throw new Error(`SMTP send failed (${code ?? "no code"})`)
  }
}
