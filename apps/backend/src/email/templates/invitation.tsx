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
      <Preview>You&apos;ve been invited to join {organizationName}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>You&apos;ve been invited</Heading>
          <Text style={paragraph}>
            <strong>{inviterName}</strong> ({inviterEmail}) has invited you to
            join <strong>{organizationName}</strong>.
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
