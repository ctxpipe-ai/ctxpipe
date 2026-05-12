import type * as cdk from "aws-cdk-lib";
import type * as route53 from "aws-cdk-lib/aws-route53";

export interface CtxPipeAuthProps {
  /**
   * Better Auth secret value. Must be at least 32 characters.
   */
  readonly authSecret: cdk.SecretValue;
}

export interface CtxPipeModelProviderProps {
  /**
   * OpenAI-compatible API base URL.
   */
  readonly baseUrl: string;
  /**
   * API key or bearer token for the model provider.
   */
  readonly apiKey: cdk.SecretValue;
  /**
   * Model ID used by backend/worker defaults.
   */
  readonly defaultModel: string;
}

export interface CtxPipeCustomDomainProps {
  /**
   * Public DNS name served by the ALB over HTTPS.
   */
  readonly domainName: string;
  /**
   * Authoritative public hosted zone used for:
   * - ACM DNS validation records.
   * - ALB alias A/AAAA records.
   * - SES domain identity + DKIM records.
   */
  readonly hostedZone: route53.IHostedZone;
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

export interface CtxPipeImageConfig {
  readonly backend?: string;
  readonly worker?: string;
  readonly ui?: string;
  readonly codesearch?: string;
}

export interface CtxPipeImagesProps {
  /**
   * Tag applied to all images unless overridden per service.
   */
  readonly defaultTag?: string;
  readonly tags?: CtxPipeImageConfig;
}

export interface CtxPipeInfraDefaultsProps {
  readonly maxAzs?: number;
  readonly natGateways?: number;
  readonly databaseName?: string;
  readonly backupRetentionDays?: number;
}

export interface CtxPipeProps {
  /**
   * Organization slug used by self-hosted deployment.
   * For Neptune, this construct configures a single-org deployment and maps
   * the cluster URI to GRAPH_DB_URI_<orgSlug>.
   */
  readonly orgSlug: string;
  readonly auth: CtxPipeAuthProps;
  readonly modelProvider: CtxPipeModelProviderProps;
  readonly customDomain: CtxPipeCustomDomainProps;
  readonly connectorSecrets?: CtxPipeConnectorSecretsProps;
  readonly images?: CtxPipeImagesProps;
  readonly infraDefaults?: CtxPipeInfraDefaultsProps;
}
