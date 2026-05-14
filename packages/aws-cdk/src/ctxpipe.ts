import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { PINNED_SERVICE_IMAGE_TAG } from "./pinned-service-image-tag";
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
const ORG_SLUG_PATTERN = /^[a-z0-9-]+$/;

export class CtxPipe extends Construct {
  public readonly appUrl: string;
  public readonly databaseUrlSecret: secretsmanager.ISecret;
  public readonly modelProviderSecret: secretsmanager.ISecret;
  public readonly smtpSecret: secretsmanager.ISecret;
  public readonly connectorSecret?: secretsmanager.ISecret;

  public constructor(scope: Construct, id: string, props: CtxPipeProps) {
    super(scope, id);

    this.validateOrgSlug(props);
    this.validateModelProvider(props);
    const resolvedCustomDomain = this.resolveCustomDomain(props);

    const defaults = this.resolveDefaults(props, resolvedCustomDomain);

    const networking = new NetworkingConstruct(this, "Networking", {
      maxAzs: 2,
      natGateways: 1,
    });

    const dataPlane = new DataPlaneConstruct(this, "DataPlane", {
      networking: networking.resources,
      defaults,
    });

    const secrets = new SecretsConstruct(this, "Secrets", {
      dataPlane: dataPlane.resources,
      databaseName: defaults.databaseName,
      modelProviderApiKey: props.modelProvider.apiKey,
      hostedZone: resolvedCustomDomain.hostedZone,
      connectorSecrets: props.connectorSecrets,
      emailFromAddress: defaults.emailFromAddress,
    });

    const taskDefinitions = new TaskDefinitionsConstruct(this, "TaskDefinitions", {
      orgSlug: props.orgSlug,
      networking: networking.resources,
      dataPlane: dataPlane.resources,
      secrets: secrets.resources,
      customDomain: resolvedCustomDomain,
      modelProviderBaseUrl: props.modelProvider.baseUrl,
      modelProviderDefaultModel: props.modelProvider.defaultModel,
      defaultImageTag: defaults.defaultImageTag,
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

  private validateOrgSlug(props: CtxPipeProps): void {
    const orgSlug = props.orgSlug.trim();
    if (orgSlug.length === 0) {
      throw new Error("orgSlug is required");
    }
    if (!ORG_SLUG_PATTERN.test(orgSlug)) {
      throw new Error("orgSlug must contain only lowercase letters, numbers, or hyphens");
    }
  }

  private resolveDefaults(
    props: CtxPipeProps,
    customDomain: ResolvedCtxPipeCustomDomainProps,
  ): CtxPipeResolvedDefaults {
    const normalizedZoneName = customDomain.hostedZoneName.replace(/\.$/, "");
    return {
      databaseName: "ctxpipe",
      backupRetentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
      defaultImageTag: PINNED_SERVICE_IMAGE_TAG,
      emailFromAddress: `ctxpipe-noreply@${normalizedZoneName}`,
    };
  }

  private resolveCustomDomain(props: CtxPipeProps): ResolvedCtxPipeCustomDomainProps {
    const hostedZoneName = this.resolveHostedZoneName(props.customDomain.hostedZoneId);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "CustomDomainHostedZone",
      {
        hostedZoneId: this.normalizeHostedZoneId(props.customDomain.hostedZoneId),
        zoneName: hostedZoneName,
      },
    );

    return {
      ...props.customDomain,
      hostedZone,
      hostedZoneName,
      certificate: new acm.Certificate(this, "CustomDomainCertificate", {
        domainName: props.customDomain.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      }),
    };
  }

  private resolveHostedZoneName(hostedZoneId: string): string {
    const lookup = new cr.AwsCustomResource(this, "HostedZoneLookup", {
      onCreate: {
        service: "Route53",
        action: "getHostedZone",
        parameters: {
          Id: this.toHostedZoneApiId(hostedZoneId),
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `route53-hosted-zone-${this.normalizeHostedZoneId(hostedZoneId)}`,
        ),
      },
      onUpdate: {
        service: "Route53",
        action: "getHostedZone",
        parameters: {
          Id: this.toHostedZoneApiId(hostedZoneId),
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `route53-hosted-zone-${this.normalizeHostedZoneId(hostedZoneId)}`,
        ),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    const normalizeFunction = new lambda.Function(this, "HostedZoneNameNormalizeFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(15),
      code: lambda.Code.fromInline(`
          exports.handler = async (event) => {
            const physicalId = event.PhysicalResourceId || "hosted-zone-name-normalized";
            if (event.RequestType === "Delete") {
              return { PhysicalResourceId: physicalId };
            }

            const rawName = String(event.ResourceProperties.HostedZoneName || "");
            const normalizedName = rawName.replace(/\\.$/, "");
            return {
              PhysicalResourceId: physicalId,
              Data: {
                HostedZoneName: normalizedName
              }
            };
          };
        `),
    });

    const normalizeProvider = new cr.Provider(this, "HostedZoneNameNormalizeProvider", {
      onEventHandler: normalizeFunction,
    });

    const normalizeResource = new cdk.CustomResource(this, "HostedZoneNameNormalize", {
      serviceToken: normalizeProvider.serviceToken,
      properties: {
        HostedZoneName: lookup.getResponseField("HostedZone.Name"),
      },
    });

    return normalizeResource.getAttString("HostedZoneName");
  }

  private normalizeHostedZoneId(hostedZoneId: string): string {
    return hostedZoneId.startsWith("/hostedzone/")
      ? hostedZoneId.slice("/hostedzone/".length)
      : hostedZoneId;
  }

  private toHostedZoneApiId(hostedZoneId: string): string {
    return hostedZoneId.startsWith("/hostedzone/")
      ? hostedZoneId
      : `/hostedzone/${hostedZoneId}`;
  }
}
