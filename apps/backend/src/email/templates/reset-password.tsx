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

interface ResetPasswordEmailProps {
  url: string
  userEmail: string
}

export function ResetPasswordEmail({ url, userEmail }: ResetPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your password</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Reset your password</Heading>
          <Text style={paragraph}>
            We received a request to reset the password for <strong>{userEmail}</strong>.
            Click the button below to choose a new password.
          </Text>
          <Section style={buttonContainer}>
            <Button href={url} style={button}>
              Reset password
            </Button>
          </Section>
          <Text style={paragraph}>
            This link expires in 1 hour. If you didn't request a password reset,
            you can safely ignore this email.
          </Text>
          <Hr style={hr} />
          <Text style={footer}>
            If the button doesn't work, copy and paste this link into your browser:{" "}
            {url}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "40px auto",
  padding: "40px",
  maxWidth: "560px",
  borderRadius: "8px",
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
  borderRadius: "6px",
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
