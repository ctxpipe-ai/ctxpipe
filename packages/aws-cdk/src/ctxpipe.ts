import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as neptune from "aws-cdk-lib/aws-neptune";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
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

    if (props.publicUrls.appUrl.length === 0) {
      throw new Error("publicUrls.appUrl is required");
    }
    if (props.modelProvider.baseUrl.length === 0) {
      throw new Error("modelProvider.baseUrl is required");
    }
    if (props.modelProvider.defaultModel.length === 0) {
      throw new Error("modelProvider.defaultModel is required");
    }

    const databaseName = props.infraDefaults?.databaseName ?? "ctxpipe";
    const backupRetentionDays =
      props.infraDefaults?.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
    const defaultImageTag = props.images?.defaultTag ?? DEFAULT_IMAGE_TAG;
    const emailFromAddress =
      props.email?.fromAddress?.trim() || DEFAULT_EMAIL_FROM_ADDRESS;

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: props.infraDefaults?.maxAzs ?? 2,
      natGateways: props.infraDefaults?.natGateways ?? 1,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(5432),
      "Allow PostgreSQL from ECS services",
    );

    const neptuneSecurityGroup = new ec2.SecurityGroup(
      this,
      "NeptuneSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      },
    );
    neptuneSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(8182),
      "Allow Neptune from ECS services",
    );

    const efsSecurityGroup = new ec2.SecurityGroup(this, "EfsSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });
    efsSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(2049),
      "Allow NFS from ECS services",
    );

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      defaultCloudMapNamespace: {
        name: "ctxpipe.local",
      },
    });

    const dbCredentialsSecret = new secretsmanager.Secret(
      this,
      "DatabaseCredentialsSecret",
      {
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: "ctxpipe" }),
          generateStringKey: "password",
          excludePunctuation: true,
        },
      },
    );

    const dbCluster = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of("16.4", "16"),
      }),
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      defaultDatabaseName: databaseName,
      writer: rds.ClusterInstance.provisioned("writer", {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM,
        ),
      }),
      backup: {
        retention: cdk.Duration.days(backupRetentionDays),
      },
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [dbSecurityGroup],
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const neptuneSubnetGroup = new neptune.CfnDBSubnetGroup(
      this,
      "NeptuneSubnetGroup",
      {
        dbSubnetGroupDescription: "Private subnets for ctxpipe neptune",
        subnetIds: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnetIds,
      },
    );

    const neptuneCluster = new neptune.CfnDBCluster(this, "Neptune", {
      dbSubnetGroupName: neptuneSubnetGroup.ref,
      vpcSecurityGroupIds: [neptuneSecurityGroup.securityGroupId],
      backupRetentionPeriod: backupRetentionDays,
      storageEncrypted: true,
      iamAuthEnabled: false,
    });
    neptuneCluster.applyRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);

    const codesearchFileSystem = new efs.FileSystem(this, "CodesearchEfs", {
      vpc,
      encrypted: true,
      securityGroup: efsSecurityGroup,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    });

    const authSecret = new secretsmanager.Secret(this, "AuthSecret", {
      secretStringValue: props.auth.authSecret,
    });

    const databaseUrl = cdk.Fn.join("", [
      "postgresql://ctxpipe:",
      dbCredentialsSecret.secretValueFromJson("password").toString(),
      "@",
      dbCluster.clusterEndpoint.hostname,
      ":",
      cdk.Token.asString(dbCluster.clusterEndpoint.port),
      "/",
      databaseName,
    ]);

    this.databaseUrlSecret = new secretsmanager.Secret(this, "DatabaseUrlSecret", {
      secretObjectValue: {
        DATABASE_URL: cdk.SecretValue.unsafePlainText(databaseUrl),
      },
    });

    this.modelProviderSecret = new secretsmanager.Secret(
      this,
      "ModelProviderSecret",
      {
        secretObjectValue: {
          API_KEY: props.modelProvider.apiKey,
        },
      },
    );

    const sesIdentity = new ses.CfnEmailIdentity(this, "SesIdentity", {
      emailIdentity: emailFromAddress,
    });

    const sesSmtpUser = new iam.User(this, "SesSmtpUser");
    sesSmtpUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );

    const sesSmtpAccessKey = new iam.CfnAccessKey(this, "SesSmtpAccessKey", {
      userName: sesSmtpUser.userName,
    });

    const smtpPasswordFunction = new lambda.Function(
      this,
      "SesSmtpPasswordFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        timeout: cdk.Duration.seconds(15),
        code: lambda.Code.fromInline(`
          const crypto = require("crypto");
          function sign(key, message) {
            return crypto.createHmac("sha256", key).update(message, "utf8").digest();
          }
          function toSmtpPassword(secretAccessKey, region) {
            const kDate = sign("AWS4" + secretAccessKey, "11111111");
            const kRegion = sign(kDate, region);
            const kService = sign(kRegion, "ses");
            const kSigning = sign(kService, "aws4_request");
            const kMessage = sign(kSigning, "SendRawEmail");
            return Buffer.concat([Buffer.from([0x04]), kMessage]).toString("base64");
          }
          exports.handler = async (event) => {
            if (event.RequestType === "Delete") {
              return { PhysicalResourceId: event.PhysicalResourceId || "ses-smtp-config" };
            }
            const accessKeyId = event.ResourceProperties.AccessKeyId;
            const secretAccessKey = event.ResourceProperties.SecretAccessKey;
            const region = event.ResourceProperties.Region;
            const fromAddress = event.ResourceProperties.FromAddress;
            const smtpPassword = toSmtpPassword(secretAccessKey, region);
            const encodedUser = encodeURIComponent(accessKeyId);
            const encodedPass = encodeURIComponent(smtpPassword);
            return {
              PhysicalResourceId: "ses-smtp-config",
              Data: {
                SmtpConnectionUrl: "smtps://" + encodedUser + ":" + encodedPass + "@email-smtp." + region + ".amazonaws.com:465",
                EmailFromAddress: fromAddress
              }
            };
          };
        `),
      },
    );

    const smtpProvider = new cr.Provider(this, "SesSmtpProvider", {
      onEventHandler: smtpPasswordFunction,
    });

    const smtpConfiguration = new cdk.CustomResource(this, "SesSmtpConfig", {
      serviceToken: smtpProvider.serviceToken,
      properties: {
        AccessKeyId: sesSmtpAccessKey.ref,
        SecretAccessKey: sesSmtpAccessKey.attrSecretAccessKey,
        Region: cdk.Stack.of(this).region,
        FromAddress: emailFromAddress,
      },
    });

    this.smtpSecret = new secretsmanager.Secret(this, "SmtpSecret", {
      secretObjectValue: {
        SMTP_CONNECTION_URL: cdk.SecretValue.unsafePlainText(
          smtpConfiguration.getAttString("SmtpConnectionUrl"),
        ),
        EMAIL_FROM_ADDRESS: cdk.SecretValue.unsafePlainText(
          smtpConfiguration.getAttString("EmailFromAddress"),
        ),
      },
    });
    this.smtpSecret.node.addDependency(sesIdentity);

    if (props.connectorSecrets) {
      this.connectorSecret = new secretsmanager.Secret(this, "ConnectorSecret", {
        secretObjectValue: {
          ...(props.connectorSecrets.githubAppId
            ? { GITHUB_APP_ID: props.connectorSecrets.githubAppId }
            : {}),
          ...(props.connectorSecrets.githubPrivateKey
            ? { GITHUB_PRIVATE_KEY: props.connectorSecrets.githubPrivateKey }
            : {}),
          ...(props.connectorSecrets.githubWebhookSecret
            ? { GITHUB_WEBHOOK_SECRET: props.connectorSecrets.githubWebhookSecret }
            : {}),
          ...(props.connectorSecrets.githubClientId
            ? { GITHUB_CLIENT_ID: props.connectorSecrets.githubClientId }
            : {}),
          ...(props.connectorSecrets.githubClientSecret
            ? { GITHUB_CLIENT_SECRET: props.connectorSecrets.githubClientSecret }
            : {}),
          ...(props.connectorSecrets.atlassianClientId
            ? { ATLASSIAN_CLIENT_ID: props.connectorSecrets.atlassianClientId }
            : {}),
          ...(props.connectorSecrets.atlassianClientSecret
            ? {
                ATLASSIAN_CLIENT_SECRET:
                  props.connectorSecrets.atlassianClientSecret,
              }
            : {}),
        },
      });
    }

    const graphDbUri = cdk.Fn.join("", ["bolt://", neptuneCluster.attrEndpoint, ":8182"]);

    const backendTask = new ecs.FargateTaskDefinition(this, "BackendTask", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });
    const uiTask = new ecs.FargateTaskDefinition(this, "UiTask", {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    const codesearchTask = new ecs.FargateTaskDefinition(this, "CodesearchTask", {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    codesearchTask.addVolume({
      name: "codesearch-data",
      efsVolumeConfiguration: {
        fileSystemId: codesearchFileSystem.fileSystemId,
        transitEncryption: "ENABLED",
      },
    });

    const connectorEnv: Record<string, ecs.Secret> = {};
    if (this.connectorSecret) {
      if (props.connectorSecrets?.githubAppId) {
        connectorEnv.GITHUB_APP_ID = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "GITHUB_APP_ID",
        );
      }
      if (props.connectorSecrets?.githubPrivateKey) {
        connectorEnv.GITHUB_PRIVATE_KEY = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "GITHUB_PRIVATE_KEY",
        );
      }
      if (props.connectorSecrets?.githubWebhookSecret) {
        connectorEnv.GITHUB_WEBHOOK_SECRET = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "GITHUB_WEBHOOK_SECRET",
        );
      }
      if (props.connectorSecrets?.githubClientId) {
        connectorEnv.GITHUB_CLIENT_ID = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "GITHUB_CLIENT_ID",
        );
      }
      if (props.connectorSecrets?.githubClientSecret) {
        connectorEnv.GITHUB_CLIENT_SECRET = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "GITHUB_CLIENT_SECRET",
        );
      }
      if (props.connectorSecrets?.atlassianClientId) {
        connectorEnv.ATLASSIAN_CLIENT_ID = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "ATLASSIAN_CLIENT_ID",
        );
      }
      if (props.connectorSecrets?.atlassianClientSecret) {
        connectorEnv.ATLASSIAN_CLIENT_SECRET = ecs.Secret.fromSecretsManager(
          this.connectorSecret,
          "ATLASSIAN_CLIENT_SECRET",
        );
      }
    }

    const backendContainer = backendTask.addContainer("backend", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/backend:${
          props.images?.tags?.backend ?? defaultImageTag
        }`,
      ),
      environment: {
        AUTH_BASE_URL: props.publicUrls.appUrl,
        AUTH_ALLOWED_ORIGINS: props.publicUrls.appUrl,
        GRAPH_DB_PROVIDER: "neptune",
        GRAPH_DB_URI: graphDbUri,
        UI_PROXY_URL: "http://ui.ctxpipe.local:3002",
        CODESEARCH_URL: "http://codesearch.ctxpipe.local:3001",
        MODEL_PROVIDER_URL: props.modelProvider.baseUrl,
        MODEL_FAST_NAME: props.modelProvider.defaultModel,
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          this.databaseUrlSecret,
          "DATABASE_URL",
        ),
        MODEL_PROVIDER_API_KEY: ecs.Secret.fromSecretsManager(
          this.modelProviderSecret,
          "API_KEY",
        ),
        SMTP_CONNECTION_URL: ecs.Secret.fromSecretsManager(
          this.smtpSecret,
          "SMTP_CONNECTION_URL",
        ),
        EMAIL_FROM_ADDRESS: ecs.Secret.fromSecretsManager(
          this.smtpSecret,
          "EMAIL_FROM_ADDRESS",
        ),
        ...connectorEnv,
      },
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-backend" }),
    });

    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/worker:${
          props.images?.tags?.worker ?? defaultImageTag
        }`,
      ),
      environment: {
        AUTH_BASE_URL: props.publicUrls.appUrl,
        AUTH_ALLOWED_ORIGINS: props.publicUrls.appUrl,
        GRAPH_DB_PROVIDER: "neptune",
        GRAPH_DB_URI: graphDbUri,
        CODESEARCH_URL: "http://codesearch.ctxpipe.local:3001",
        MODEL_PROVIDER_URL: props.modelProvider.baseUrl,
        MODEL_FAST_NAME: props.modelProvider.defaultModel,
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          this.databaseUrlSecret,
          "DATABASE_URL",
        ),
        MODEL_PROVIDER_API_KEY: ecs.Secret.fromSecretsManager(
          this.modelProviderSecret,
          "API_KEY",
        ),
        ...connectorEnv,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-worker" }),
    });

    uiTask.addContainer("ui", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/ui:${props.images?.tags?.ui ?? defaultImageTag}`,
      ),
      environment: {
        VITE_PUBLIC_API_URL: props.publicUrls.appUrl,
      },
      portMappings: [{ containerPort: 3002 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-ui" }),
    });

    const codesearchContainer = codesearchTask.addContainer("codesearch", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/codesearch:${
          props.images?.tags?.codesearch ?? defaultImageTag
        }`,
      ),
      environment: {
        ZOEKT_WEBSERVER_URL: "http://127.0.0.1:6070",
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          this.databaseUrlSecret,
          "DATABASE_URL",
        ),
      },
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-codesearch" }),
    });
    codesearchContainer.addMountPoints({
      sourceVolume: "codesearch-data",
      containerPath: "/data",
      readOnly: false,
    });

    const migrateTask = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    migrateTask.addContainer("migrate", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/backend:${
          props.images?.tags?.backend ?? defaultImageTag
        }`,
      ),
      command: ["bun", "run", "apps/backend/src/db/migrate.ts"],
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          this.databaseUrlSecret,
          "DATABASE_URL",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-migrate" }),
    });

    this.grantTaskSecrets(backendTask, [
      authSecret,
      this.databaseUrlSecret,
      this.modelProviderSecret,
      this.smtpSecret,
      this.connectorSecret,
    ]);
    this.grantTaskSecrets(workerTask, [
      authSecret,
      this.databaseUrlSecret,
      this.modelProviderSecret,
      this.connectorSecret,
    ]);
    this.grantTaskSecrets(codesearchTask, [this.databaseUrlSecret]);
    this.grantTaskSecrets(migrateTask, [this.databaseUrlSecret]);

    const backendService = new ecs.FargateService(this, "BackendService", {
      cluster,
      taskDefinition: backendTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSecurityGroup],
      cloudMapOptions: {
        name: "backend",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    new ecs.FargateService(this, "WorkerService", {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSecurityGroup],
      cloudMapOptions: {
        name: "worker",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    new ecs.FargateService(this, "UiService", {
      cluster,
      taskDefinition: uiTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSecurityGroup],
      cloudMapOptions: {
        name: "ui",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    new ecs.FargateService(this, "CodesearchService", {
      cluster,
      taskDefinition: codesearchTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSecurityGroup],
      cloudMapOptions: {
        name: "codesearch",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    const httpListener = alb.addListener("HttpListener", {
      port: 80,
      open: true,
    });

    if (props.customDomain) {
      this.attachCustomDomain(props.customDomain.certificate);

      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        open: true,
        certificates: [props.customDomain.certificate],
      });
      httpsListener.addTargets("BackendHttpsTarget", {
        targets: [backendService.loadBalancerTarget({ containerName: "backend", containerPort: 3000 })],
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          path: "/health",
          healthyHttpCodes: "200-399",
        },
      });

      if (props.customDomain.redirectHttpToHttps ?? true) {
        httpListener.addAction("HttpRedirect", {
          action: elbv2.ListenerAction.redirect({
            protocol: "HTTPS",
            port: "443",
            permanent: true,
          }),
        });
      } else {
        httpListener.addTargets("BackendHttpTarget", {
          targets: [
            backendService.loadBalancerTarget({
              containerName: "backend",
              containerPort: 3000,
            }),
          ],
          port: 3000,
          protocol: elbv2.ApplicationProtocol.HTTP,
          healthCheck: {
            path: "/health",
            healthyHttpCodes: "200-399",
          },
        });
      }

      new route53.ARecord(this, "AlbAliasA", {
        zone: props.customDomain.hostedZone,
        recordName: props.customDomain.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(alb),
        ),
      });
      new route53.AaaaRecord(this, "AlbAliasAaaa", {
        zone: props.customDomain.hostedZone,
        recordName: props.customDomain.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(alb),
        ),
      });

      this.appUrl = `https://${props.customDomain.domainName}`;
    } else {
      httpListener.addTargets("BackendHttpTarget", {
        targets: [
          backendService.loadBalancerTarget({
            containerName: "backend",
            containerPort: 3000,
          }),
        ],
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          path: "/health",
          healthyHttpCodes: "200-399",
        },
      });
      this.appUrl = props.publicUrls.appUrl;
    }

    new cdk.CfnOutput(this, "AppUrl", {
      value: this.appUrl,
    });
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, "DatabaseUrlSecretArn", {
      value: this.databaseUrlSecret.secretArn,
    });
    new cdk.CfnOutput(this, "ModelProviderSecretArn", {
      value: this.modelProviderSecret.secretArn,
    });
    new cdk.CfnOutput(this, "SmtpSecretArn", {
      value: this.smtpSecret.secretArn,
    });
    new cdk.CfnOutput(this, "MigrateTaskDefinitionArn", {
      value: migrateTask.taskDefinitionArn,
    });
    if (this.connectorSecret) {
      new cdk.CfnOutput(this, "ConnectorSecretArn", {
        value: this.connectorSecret.secretArn,
      });
    }
  }

  private grantTaskSecrets(
    task: ecs.FargateTaskDefinition,
    secrets: Array<secretsmanager.ISecret | undefined>,
  ): void {
    const principals = [task.taskRole, task.executionRole].filter(
      (role): role is iam.IRole => role !== undefined,
    );
    for (const secret of secrets) {
      if (!secret) {
        continue;
      }
      for (const principal of principals) {
        secret.grantRead(principal);
      }
    }
  }

  private attachCustomDomain(certificate: acm.ICertificate): void {
    if (
      cdk.Token.isUnresolved(certificate.certificateArn) ||
      certificate.certificateArn.length === 0
    ) {
      throw new Error("customDomain.certificate must include a valid ACM certificate ARN");
    }
  }
}
