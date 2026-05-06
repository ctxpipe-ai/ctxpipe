import type * as cdk from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
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
  readonly domainName: string;
  readonly hostedZone: route53.IHostedZone;
  readonly certificate: acm.ICertificate;
  readonly redirectHttpToHttps?: boolean;
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

export interface CtxPipeEmailProps {
  /**
   * Sender address for transactional emails.
   * This address must be verified in SES.
   */
  readonly fromAddress?: string;
}

export interface CtxPipeProps {
  readonly auth: CtxPipeAuthProps;
  readonly modelProvider: CtxPipeModelProviderProps;
  readonly customDomain?: CtxPipeCustomDomainProps;
  readonly connectorSecrets?: CtxPipeConnectorSecretsProps;
  readonly email?: CtxPipeEmailProps;
  readonly images?: CtxPipeImagesProps;
  readonly infraDefaults?: CtxPipeInfraDefaultsProps;
}
