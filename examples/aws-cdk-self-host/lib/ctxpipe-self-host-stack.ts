import * as cdk from "aws-cdk-lib";
import { CtxPipe } from "@ctxpipe/aws-cdk";
import type {
  CtxPipeConnectorSecretsProps,
  CtxPipeProps,
} from "@ctxpipe/aws-cdk";
import type { Construct } from "constructs";

export interface CtxpipeSelfHostStackProps extends cdk.StackProps {
  readonly orgSlug: string;
  readonly modelBaseUrl: string;
  readonly modelApiKey: string;
  readonly modelDefaultModel: string;
  readonly customDomain: {
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

    const connectorSecrets = this.buildConnectorSecrets(props.connectorSecrets);

    const ctxPipeProps: CtxPipeProps = {
      orgSlug: props.orgSlug,
      modelProvider: {
        baseUrl: props.modelBaseUrl,
        apiKey: cdk.SecretValue.unsafePlainText(props.modelApiKey),
        defaultModel: props.modelDefaultModel,
      },
      customDomain: props.customDomain,
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
