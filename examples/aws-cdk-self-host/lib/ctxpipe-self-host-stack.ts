import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { CtxPipe } from "@ctxpipe/aws-cdk";
import type {
  CtxPipeConnectorSecretsProps,
  CtxPipeProps,
} from "@ctxpipe/aws-cdk";
import type { Construct } from "constructs";

export interface CtxpipeSelfHostStackProps extends cdk.StackProps {
  readonly authSecret: string;
  readonly modelBaseUrl: string;
  readonly modelApiKey: string;
  readonly modelDefaultModel: string;
  readonly customDomain?: {
    readonly domainName: string;
    readonly hostedZoneId: string;
  };
  readonly connectorSecrets?: Partial<{
    readonly githubAppId: string;
    readonly githubPrivateKey: string;
    readonly githubWebhookSecret: string;
    readonly githubClientId: string;
    readonly githubClientSecret: string;
    readonly atlassianClientId: string;
    readonly atlassianClientSecret: string;
  }>;
  readonly imagesDefaultTag?: string;
}

export class CtxpipeSelfHostStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: CtxpipeSelfHostStackProps) {
    super(scope, id, props);

    if (props.authSecret.length < 32) {
      throw new Error("authSecret must be at least 32 characters");
    }

    const customDomain = props.customDomain
      ? {
          domainName: props.customDomain.domainName,
          hostedZone: route53.HostedZone.fromHostedZoneId(
            this,
            "PublicHostedZone",
            props.customDomain.hostedZoneId,
          ),
        }
      : undefined;

    const connectorSecrets = this.buildConnectorSecrets(props.connectorSecrets);

    const ctxPipeProps: CtxPipeProps = {
      auth: {
        authSecret: cdk.SecretValue.unsafePlainText(props.authSecret),
      },
      modelProvider: {
        baseUrl: props.modelBaseUrl,
        apiKey: cdk.SecretValue.unsafePlainText(props.modelApiKey),
        defaultModel: props.modelDefaultModel,
      },
      ...(customDomain ? { customDomain } : {}),
      ...(connectorSecrets ? { connectorSecrets } : {}),
      ...(props.imagesDefaultTag
        ? { images: { defaultTag: props.imagesDefaultTag } }
        : {}),
      infraDefaults: {
        backupRetentionDays: 1,
      },
    };

    new CtxPipe(this, "CtxPipe", ctxPipeProps);
  }

  private buildConnectorSecrets(
    input: CtxpipeSelfHostStackProps["connectorSecrets"],
  ): CtxPipeConnectorSecretsProps | undefined {
    if (!input) {
      return undefined;
    }
    const out = {
      ...(input.githubAppId
        ? { githubAppId: cdk.SecretValue.unsafePlainText(input.githubAppId) }
        : {}),
      ...(input.githubPrivateKey
        ? { githubPrivateKey: cdk.SecretValue.unsafePlainText(input.githubPrivateKey) }
        : {}),
      ...(input.githubWebhookSecret
        ? {
            githubWebhookSecret: cdk.SecretValue.unsafePlainText(
              input.githubWebhookSecret,
            ),
          }
        : {}),
      ...(input.githubClientId
        ? { githubClientId: cdk.SecretValue.unsafePlainText(input.githubClientId) }
        : {}),
      ...(input.githubClientSecret
        ? {
            githubClientSecret: cdk.SecretValue.unsafePlainText(
              input.githubClientSecret,
            ),
          }
        : {}),
      ...(input.atlassianClientId
        ? {
            atlassianClientId: cdk.SecretValue.unsafePlainText(
              input.atlassianClientId,
            ),
          }
        : {}),
      ...(input.atlassianClientSecret
        ? {
            atlassianClientSecret: cdk.SecretValue.unsafePlainText(
              input.atlassianClientSecret,
            ),
          }
        : {}),
    };
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
