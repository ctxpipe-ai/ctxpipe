import type * as cdk from "aws-cdk-lib";

export type CtxPipeSize = "small" | "medium" | "large";

/**
 * Per-tier model IDs. Omitted medium/high cascade: medium → fast, high → medium.
 */
export interface CtxPipeModelTiers {
  readonly fast: string;
  readonly medium?: string;
  readonly high?: string;
  readonly embedding?: string;
}

/**
 * OpenAI-compatible HTTP model provider (default when `kind` is omitted).
 */
export interface CtxPipeOpenAiLikeModelProviderProps {
  readonly kind?: "openai-like";
  /**
   * OpenAI-compatible API base URL.
   */
  readonly baseUrl: string;
  /**
   * API key or bearer token for the model provider.
   */
  readonly apiKey: cdk.SecretValue;
  /**
   * Tier model IDs (`fast` required; medium/high/embedding optional).
   */
  readonly models: CtxPipeModelTiers;
}

/**
 * Amazon Bedrock via native Runtime SDK (IAM task role).
 */
export interface CtxPipeBedrockModelProviderProps {
  readonly kind: "bedrock";
  /**
   * AWS region for Bedrock (defaults to stack region when omitted).
   */
  readonly region?: string;
  /**
   * Tier model IDs (`fast` required; medium/high/embedding optional).
   */
  readonly models: CtxPipeModelTiers;
}

export type CtxPipeModelProviderProps =
  | CtxPipeOpenAiLikeModelProviderProps
  | CtxPipeBedrockModelProviderProps;

export interface CtxPipeCustomDomainProps {
  /**
   * Public DNS name served by the ALB over HTTPS.
   */
  readonly domainName: string;
  /**
   * Authoritative public hosted zone ID used for:
   * - ACM DNS validation records.
   * - ALB alias A/AAAA records.
   * - SES domain identity + DKIM records.
   *
   * This construct resolves hosted-zone details internally.
   */
  readonly hostedZoneId: string;
}

export interface CtxPipeConnectorSecretsProps {
  readonly githubAppId?: cdk.SecretValue;
  readonly githubPrivateKey?: cdk.SecretValue;
  readonly githubWebhookSecret?: cdk.SecretValue;
  readonly githubClientId?: cdk.SecretValue;
  readonly githubClientSecret?: cdk.SecretValue;
  readonly atlassianClientId?: cdk.SecretValue;
  readonly atlassianClientSecret?: cdk.SecretValue;
  readonly slackClientId?: cdk.SecretValue;
  readonly slackClientSecret?: cdk.SecretValue;
  readonly slackSigningSecret?: cdk.SecretValue;
  readonly linearClientId?: cdk.SecretValue;
  readonly linearClientSecret?: cdk.SecretValue;
  readonly linearRedirectUri?: cdk.SecretValue;
  readonly linearWebhookSecret?: cdk.SecretValue;
  readonly notionClientId?: cdk.SecretValue;
  readonly notionClientSecret?: cdk.SecretValue;
  readonly notionWebhookSecret?: cdk.SecretValue;
  readonly pagerdutyClientId?: cdk.SecretValue;
  readonly pagerdutyClientSecret?: cdk.SecretValue;
  readonly pagerdutyRedirectUri?: cdk.SecretValue;
}

/**
 * Optional OTLP export. Omit to leave telemetry off.
 * The construct does not deploy a collector, Langfuse, or ClickStack.
 *
 * One base URL covers traces, logs, and metrics. A different URL per signal
 * is not supported; point `endpoint` at a collector that fans out.
 */
export interface CtxPipeOtelProps {
  /**
   * OTLP/HTTP base URL, without a signal path and without a trailing slash.
   * The construct sets `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to
   * `${endpoint}/v1/traces`, and the same for logs and metrics.
   * A blank value throws. Omit `otel` to leave export off.
   */
  readonly endpoint: string;
  /**
   * `OTEL_EXPORTER_OTLP_HEADERS`, for example `Authorization=Bearer xxx`.
   * Stored in Secrets Manager and injected into the app tasks when export is on.
   */
  readonly headers?: cdk.SecretValue;
  /**
   * `OTEL_RESOURCE_ATTRIBUTES`, for example `deployment.environment=production`.
   * Set on the app tasks when export is on.
   */
  readonly resourceAttributes?: string;
}

export interface CtxPipeProps {
  /**
   * Organization slug used by self-hosted deployment.
   * For Neptune, this construct configures a single-org deployment and maps
   * the cluster URI to GRAPH_DB_URI_<orgSlug>.
   */
  readonly orgSlug: string;
  readonly modelProvider: CtxPipeModelProviderProps;
  readonly customDomain: CtxPipeCustomDomainProps;
  readonly connectorSecrets?: CtxPipeConnectorSecretsProps;
  /**
   * Optional OpenTelemetry export to the operator's OTLP endpoint.
   * Omit to export nothing.
   */
  readonly otel?: CtxPipeOtelProps;
  /**
   * Capacity profile for single-tenant self-hosting.
   * Defaults to "small" when omitted.
   */
  readonly size?: CtxPipeSize;
}
