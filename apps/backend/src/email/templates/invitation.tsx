import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import * as React from "react"

interface InvitationEmailProps {
  inviteLink: string
  inviterName: string
  inviterEmail: string
  organizationName: string
}

export function InvitationEmail({
  inviteLink,
  inviterName,
  inviterEmail,
  organizationName,
}: InvitationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        You&apos;ve been invited to join {organizationName} on ctx|
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>ctx|</Text>
          <Heading style={heading}>You&apos;ve been invited</Heading>
          <Text style={paragraph}>
            <strong>{inviterName}</strong> ({inviterEmail}) has invited you to
            join <strong>{organizationName}</strong> on{" "}
            <strong>ctx|</strong>.
          </Text>
          <Section style={buttonContainer}>
            <Button href={inviteLink} style={button}>
              Accept invitation
            </Button>
          </Section>
          <Text style={paragraph}>
            This invitation expires in 48 hours. If you weren&apos;t expecting
            this, you can safely ignore this email.
          </Text>
          <Hr style={hr} />
          <Text style={footer}>
            If the button doesn&apos;t work, copy and paste this link into your
            browser: {inviteLink}
          </Text>
          <Text style={brandFooter}>ctx| - the self-learning context layer for engineering AI agents & humans</Text>
        </Container>
      </Body>
    </Html>
  )
}

const BRAND_TEAL = "#40e0d0"

const main: React.CSSProperties = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "40px auto",
  padding: "40px",
  maxWidth: "560px",
  borderRadius: "0",
}

const logo: React.CSSProperties = {
  fontFamily: '"SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace',
  fontSize: "28px",
  fontWeight: "700",
  color: BRAND_TEAL,
  margin: "0 0 32px",
  letterSpacing: "-0.02em",
}

const heading: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: "600",
  color: "#1a1a1a",
  margin: "0 0 24px",
}

const paragraph: React.CSSProperties = {
  fontSize: "16px",
  lineHeight: "24px",
  color: "#444444",
  margin: "0 0 20px",
}

const buttonContainer: React.CSSProperties = {
  margin: "32px 0",
}

const button: React.CSSProperties = {
  backgroundColor: "#18181b",
  borderRadius: "0",
  color: "#ffffff",
  fontSize: "15px",
  fontWeight: "600",
  padding: "12px 24px",
  textDecoration: "none",
  display: "inline-block",
}

const hr: React.CSSProperties = {
  borderColor: "#e6e6e6",
  margin: "32px 0 24px",
}

const footer: React.CSSProperties = {
  fontSize: "12px",
  lineHeight: "18px",
  color: "#888888",
  wordBreak: "break-all",
}

const brandFooter: React.CSSProperties = {
  fontSize: "12px",
  color: "#aaaaaa",
  margin: "24px 0 0",
  textAlign: "center" as const,
}
