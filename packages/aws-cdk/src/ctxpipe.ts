import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type {
  CtxPipeResolvedDefaults,
  ResolvedCtxPipeCustomDomainProps,
} from "./internal/contracts";
import { DataPlaneConstruct } from "./internal/data-plane-construct";
import { IngressConstruct } from "./internal/ingress-construct";
import { MigrateOnDeployConstruct } from "./internal/migrate-on-deploy-construct";
import { NetworkingConstruct } from "./internal/networking-construct";
import { OutputsConstruct } from "./internal/outputs-construct";
import { SecretsConstruct } from "./internal/secrets-construct";
import { ServicesConstruct } from "./internal/services-construct";
import { TaskDefinitionsConstruct } from "./internal/task-definitions-construct";
import type { CtxPipeProps } from "./types";

const DEFAULT_BACKUP_RETENTION_DAYS = 7;
const DEFAULT_IMAGE_TAG = "latest";
const DEFAULT_EMAIL_FROM_ADDRESS = "noreply@example.com";

export class CtxPipe extends Construct {
  public readonly appUrl: string;
  public readonly databaseUrlSecret: secretsmanager.ISecret;
  public readonly modelProviderSecret: secretsmanager.ISecret;
  public readonly smtpSecret: secretsmanager.ISecret;
  public readonly connectorSecret?: secretsmanager.ISecret;

  public constructor(scope: Construct, id: string, props: CtxPipeProps) {
    super(scope, id);

    this.validateModelProvider(props);
    const resolvedCustomDomain = this.resolveCustomDomain(props);

    const defaults = this.resolveDefaults(props);

    const networking = new NetworkingConstruct(this, "Networking", {
      maxAzs: props.infraDefaults?.maxAzs ?? 2,
      natGateways: props.infraDefaults?.natGateways ?? 1,
    });

    const dataPlane = new DataPlaneConstruct(this, "DataPlane", {
      networking: networking.resources,
      defaults,
    });

    const secrets = new SecretsConstruct(this, "Secrets", {
      dataPlane: dataPlane.resources,
      databaseName: defaults.databaseName,
      authSecretValue: props.auth.authSecret,
      modelProviderApiKey: props.modelProvider.apiKey,
      connectorSecrets: props.connectorSecrets,
      emailFromAddress: defaults.emailFromAddress,
    });

    const taskDefinitions = new TaskDefinitionsConstruct(this, "TaskDefinitions", {
      networking: networking.resources,
      dataPlane: dataPlane.resources,
      secrets: secrets.resources,
      customDomain: resolvedCustomDomain,
      modelProviderBaseUrl: props.modelProvider.baseUrl,
      modelProviderDefaultModel: props.modelProvider.defaultModel,
      defaultImageTag: defaults.defaultImageTag,
      imageTags: props.images?.tags,
    });

    const migrateOnDeploy = new MigrateOnDeployConstruct(this, "MigrateOnDeploy", {
      networking: networking.resources,
      dataPlane: dataPlane.resources,
      tasks: taskDefinitions.resources,
      secrets: secrets.resources,
    });

    const services = new ServicesConstruct(this, "Services", {
      networking: networking.resources,
      tasks: taskDefinitions.resources,
      migrateDependency: migrateOnDeploy.resources.migrateResource,
    });

    const ingress = new IngressConstruct(this, "Ingress", {
      networking: networking.resources,
      backendService: services.resources.backendService,
      customDomain: resolvedCustomDomain,
    });

    this.databaseUrlSecret = secrets.resources.databaseUrlSecret;
    this.modelProviderSecret = secrets.resources.modelProviderSecret;
    this.smtpSecret = secrets.resources.smtpSecret;
    this.connectorSecret = secrets.resources.connectorSecret;
    this.appUrl = ingress.resources.appUrl;

    new OutputsConstruct(this, "Outputs", {
      appUrl: this.appUrl,
      albDnsName: networking.resources.alb.loadBalancerDnsName,
      databaseUrlSecretArn: this.databaseUrlSecret.secretArn,
      modelProviderSecretArn: this.modelProviderSecret.secretArn,
      smtpSecretArn: this.smtpSecret.secretArn,
      connectorSecretArn: this.connectorSecret?.secretArn,
    });
  }

  private validateModelProvider(props: CtxPipeProps): void {
    if (props.modelProvider.baseUrl.length === 0) {
      throw new Error("modelProvider.baseUrl is required");
    }
    if (props.modelProvider.defaultModel.length === 0) {
      throw new Error("modelProvider.defaultModel is required");
    }
  }

  private resolveDefaults(props: CtxPipeProps): CtxPipeResolvedDefaults {
    return {
      databaseName: props.infraDefaults?.databaseName ?? "ctxpipe",
      backupRetentionDays:
        props.infraDefaults?.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
      defaultImageTag: props.images?.defaultTag ?? DEFAULT_IMAGE_TAG,
      emailFromAddress: props.email?.fromAddress?.trim() || DEFAULT_EMAIL_FROM_ADDRESS,
    };
  }

  private resolveCustomDomain(props: CtxPipeProps): ResolvedCtxPipeCustomDomainProps | undefined {
    if (!props.customDomain) {
      return undefined;
    }

    return {
      ...props.customDomain,
      certificate: new acm.Certificate(this, "CustomDomainCertificate", {
        domainName: props.customDomain.domainName,
        validation: acm.CertificateValidation.fromDns(props.customDomain.hostedZone),
      }),
    };
  }
}
