import type * as cdk from "aws-cdk-lib";

export type CtxPipeSize = "small" | "medium" | "large";

/**
 * Per-tier model IDs. Omitted tiers fall back to backend defaults.
 */
export interface CtxPipeModelTiers {
  readonly fast?: string;
  readonly medium?: string;
  readonly high?: string;
  readonly embedding?: string;
}

/**
 * OpenAI-compatible HTTP model provider (default when `kind` is omitted).
 *
 * Existing `{ baseUrl, apiKey, defaultModel }` objects satisfy this shape.
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
   * Model ID used when tier-specific names are not set (maps to fast tier).
   */
  readonly defaultModel: string;
  readonly models?: CtxPipeModelTiers;
}

/**
 * Amazon Bedrock via OpenAI-compatible Mantle endpoint (IAM or API key in task role).
 */
export interface CtxPipeBedrockModelProviderProps {
  readonly kind: "bedrock";
  /**
   * AWS region for Bedrock Mantle (defaults to stack region when omitted).
   */
  readonly region?: string;
  /**
   * Tier model IDs (at least one tier should be set).
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
   * Capacity profile for single-tenant self-hosting.
   * Defaults to "small" when omitted.
   */
  readonly size?: CtxPipeSize;
}
