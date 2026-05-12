import type * as cdk from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecs from "aws-cdk-lib/aws-ecs";
import type * as efs from "aws-cdk-lib/aws-efs";
import type * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type * as neptune from "aws-cdk-lib/aws-neptune";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as route53 from "aws-cdk-lib/aws-route53";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { IDependable } from "constructs";
import type { CtxPipeConnectorSecretsProps, CtxPipeCustomDomainProps } from "../types";

export interface ResolvedCtxPipeCustomDomainProps extends CtxPipeCustomDomainProps {
  readonly certificate: acm.ICertificate;
}

export interface CtxPipeResolvedDefaults {
  readonly databaseName: string;
  readonly backupRetentionDays: number;
  readonly defaultImageTag: string;
  readonly emailFromAddress: string;
}

export interface NetworkingResources {
  readonly vpc: ec2.Vpc;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly neptuneSecurityGroup: ec2.SecurityGroup;
  readonly efsSecurityGroup: ec2.SecurityGroup;
  readonly cluster: ecs.Cluster;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpListener: elbv2.ApplicationListener;
}

export interface DataPlaneResources {
  readonly dbCluster: rds.DatabaseCluster;
  readonly dbCredentialsSecret: secretsmanager.Secret;
  readonly neptuneCluster: neptune.CfnDBCluster;
  readonly neptuneInstance: neptune.CfnDBInstance;
  readonly codesearchFileSystem: efs.FileSystem;
  readonly graphDbUri: string;
}

export interface SecretsResources {
  readonly authSecret: secretsmanager.Secret;
  readonly databaseUrlSecret: secretsmanager.Secret;
  readonly modelProviderSecret: secretsmanager.Secret;
  readonly smtpSecret: secretsmanager.Secret;
  readonly connectorSecret?: secretsmanager.Secret;
  readonly connectorEnv: Record<string, ecs.Secret>;
}

export interface TaskDefinitionsResources {
  readonly backendTask: ecs.FargateTaskDefinition;
  readonly workerTask: ecs.FargateTaskDefinition;
  readonly uiTask: ecs.FargateTaskDefinition;
  readonly codesearchTask: ecs.FargateTaskDefinition;
  readonly migrateTask: ecs.FargateTaskDefinition;
}

export interface ServiceResources {
  readonly backendService: ecs.FargateService;
  readonly workerService: ecs.FargateService;
  readonly uiService: ecs.FargateService;
  readonly codesearchService: ecs.FargateService;
}

export interface IngressResources {
  readonly appUrl: string;
}

export interface MigrateOnDeployResources {
  readonly migrateResource: cdk.CustomResource;
}

export interface NetworkingConstructProps {
  readonly maxAzs: number;
  readonly natGateways: number;
}

export interface DataPlaneConstructProps {
  readonly networking: NetworkingResources;
  readonly defaults: CtxPipeResolvedDefaults;
}

export interface SecretsConstructProps {
  readonly dataPlane: DataPlaneResources;
  readonly databaseName: string;
  readonly authSecretValue: cdk.SecretValue;
  readonly modelProviderApiKey: cdk.SecretValue;
  readonly hostedZone: route53.IHostedZone;
  readonly connectorSecrets?: CtxPipeConnectorSecretsProps;
  readonly emailFromAddress: string;
}

export interface TaskDefinitionsConstructProps {
  readonly orgSlug: string;
  readonly networking: NetworkingResources;
  readonly dataPlane: DataPlaneResources;
  readonly secrets: SecretsResources;
  readonly customDomain: ResolvedCtxPipeCustomDomainProps;
  readonly modelProviderBaseUrl: string;
  readonly modelProviderDefaultModel: string;
  readonly defaultImageTag: string;
  readonly imageTags?: {
    readonly backend?: string;
    readonly worker?: string;
    readonly ui?: string;
    readonly codesearch?: string;
  };
}

export interface ServicesConstructProps {
  readonly networking: NetworkingResources;
  readonly tasks: TaskDefinitionsResources;
  readonly migrateDependency?: IDependable;
}

export interface IngressConstructProps {
  readonly networking: NetworkingResources;
  readonly backendService: ecs.FargateService;
  readonly customDomain: ResolvedCtxPipeCustomDomainProps;
}

export interface MigrateOnDeployConstructProps {
  readonly networking: NetworkingResources;
  readonly dataPlane: DataPlaneResources;
  readonly tasks: TaskDefinitionsResources;
  readonly secrets: SecretsResources;
}

export interface OutputsConstructProps {
  readonly appUrl: string;
  readonly albDnsName: string;
  readonly databaseUrlSecretArn: string;
  readonly modelProviderSecretArn: string;
  readonly smtpSecretArn: string;
  readonly connectorSecretArn?: string;
}
