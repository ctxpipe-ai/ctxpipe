import type * as cdk from "aws-cdk-lib";

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
   * GHCR image tag shared by backend, worker, UI, codesearch, and migrate tasks.
   * When omitted, defaults to the monorepo HEAD commit SHA baked in when `@ctxpipe-ai/aws-cdk`
   * was built (matching GHCR tags published for that commit). Falls back to `latest` if Git
   * was unavailable at build time.
   */
  readonly serviceImageTag?: string;
}
