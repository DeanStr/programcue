import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";

export type ProgramCueEmailProps = {
  preview: string;
  heading: string;
  body: string;
  eventName: string;
  accent: string;
  logoUrl?: string;
  physicalAddress: string;
  buttonText?: string;
  buttonUrl?: string;
  unsubscribeUrl?: string;
};

const palette = {
  canvas: "#f5f5f8",
  card: "#ffffff",
  text: "#18181b",
  muted: "#71717a",
  border: "#e4e4e7",
};

const paragraphStyle = {
  color: palette.text,
  fontSize: 16,
  lineHeight: "25px",
  margin: "0 0 16px",
  whiteSpace: "pre-line",
} as const;

export function ProgramCueEmail({
  preview,
  heading,
  body,
  eventName,
  accent,
  logoUrl,
  physicalAddress,
  buttonText,
  buttonUrl,
  unsubscribeUrl,
}: ProgramCueEmailProps) {
  const brand = programmeAccentPalette(accent);
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          backgroundColor: palette.canvas,
          color: palette.text,
          fontFamily: "Inter, Arial, sans-serif",
        }}
      >
        <Container
          style={{ maxWidth: 600, margin: "32px auto", padding: "0 16px" }}
        >
          <Section
            style={{
              backgroundColor: palette.card,
              border: `1px solid ${palette.border}`,
              borderRadius: 14,
              padding: 32,
            }}
          >
            <Section style={{ margin: "0 0 18px" }}>
              {logoUrl ? (
                <Img
                  src={logoUrl}
                  alt={`${eventName} logo`}
                  width="120"
                  style={{
                    display: "block",
                    height: 48,
                    marginBottom: 12,
                    maxWidth: 120,
                    objectFit: "contain",
                  }}
                />
              ) : null}
              <Text
                style={{
                  color: brand.ink,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: ".08em",
                  margin: 0,
                  textTransform: "uppercase",
                }}
              >
                {eventName}
              </Text>
            </Section>
            <Heading
              as="h1"
              style={{
                color: palette.text,
                fontSize: 26,
                lineHeight: "34px",
                margin: "0 0 18px",
              }}
            >
              {heading}
            </Heading>
            {body.split(/\n{2,}/).map((paragraph, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Email paragraphs are stateless output and duplicate paragraph content is valid.
              <Text key={index} style={paragraphStyle}>
                {paragraph}
              </Text>
            ))}
            {buttonText && buttonUrl ? (
              <Button
                href={buttonUrl}
                style={{
                  backgroundColor: brand.ink,
                  borderRadius: 8,
                  color: "#ffffff",
                  display: "inline-block",
                  fontSize: 15,
                  fontWeight: 700,
                  marginTop: 8,
                  padding: "12px 18px",
                  textDecoration: "none",
                }}
              >
                {buttonText}
              </Button>
            ) : null}
            <Hr
              style={{ borderColor: palette.border, margin: "28px 0 18px" }}
            />
            <Text
              style={{
                color: palette.muted,
                fontSize: 12,
                lineHeight: "18px",
                margin: 0,
              }}
            >
              {physicalAddress}
            </Text>
            <Text
              style={{
                color: palette.muted,
                fontSize: 12,
                lineHeight: "18px",
                margin: "8px 0 0",
              }}
            >
              Sent with Program Cue
            </Text>
            {unsubscribeUrl ? (
              <Text
                style={{
                  color: palette.muted,
                  fontSize: 12,
                  lineHeight: "18px",
                  margin: "8px 0 0",
                }}
              >
                This is an optional message.{" "}
                <Link
                  href={unsubscribeUrl}
                  style={{ color: brand.ink, textDecoration: "underline" }}
                >
                  Unsubscribe from messages like this
                </Link>
                .
              </Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
