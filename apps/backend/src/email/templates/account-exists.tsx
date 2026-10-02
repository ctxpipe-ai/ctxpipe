import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import * as React from "react"

interface AccountExistsEmailProps {
  signInUrl: string
  resetUrl: string
  userEmail: string
}

/** Sent when someone signs up with an address that already has an account. */
export function AccountExistsEmail({
  signInUrl,
  resetUrl,
  userEmail,
}: AccountExistsEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>You already have a ctx| account</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={logo}>ctx|</Text>
          <Heading style={heading}>You already have an account</Heading>
          <Text style={paragraph}>
            Someone tried to create a <strong>ctx|</strong> account for{" "}
            <strong>{userEmail}</strong>, which already has one. Sign in
            instead, or reset your password if you have forgotten it.
          </Text>
          <Section style={buttonContainer}>
            <Button href={signInUrl} style={button}>
              Sign in
            </Button>
          </Section>
          <Text style={paragraph}>
            Forgot your password? <a href={resetUrl}>Reset it</a>. If this
            wasn&apos;t you, you can ignore this email.
          </Text>
          <Text style={brandFooter}>
            ctx| - the self-learning context layer for engineering AI agents &
            humans
          </Text>
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

const brandFooter: React.CSSProperties = {
  fontSize: "12px",
  color: "#aaaaaa",
  margin: "24px 0 0",
  textAlign: "center" as const,
}
