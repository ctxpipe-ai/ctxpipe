import * as ecs from "aws-cdk-lib/aws-ecs";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { buildModelContainerConfig } from "../model-provider";
import type {
  TaskDefinitionsConstructProps,
  TaskDefinitionsResources,
} from "./contracts";

export class TaskDefinitionsConstruct extends Construct {
  public readonly resources: TaskDefinitionsResources;

  public constructor(scope: Construct, id: string, props: TaskDefinitionsConstructProps) {
    super(scope, id);

    const appUrl = `https://${props.customDomain.domainName}`;
    const modelContainerConfig = buildModelContainerConfig(props.resolvedModel);

    const backendTask = new ecs.FargateTaskDefinition(this, "BackendTask", {
      memoryLimitMiB: props.sizeProfile.tasks.backend.memoryLimitMiB,
      cpu: props.sizeProfile.tasks.backend.cpu,
    });
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      memoryLimitMiB: props.sizeProfile.tasks.worker.memoryLimitMiB,
      cpu: props.sizeProfile.tasks.worker.cpu,
    });
    const uiTask = new ecs.FargateTaskDefinition(this, "UiTask", {
      memoryLimitMiB: props.sizeProfile.tasks.ui.memoryLimitMiB,
      cpu: props.sizeProfile.tasks.ui.cpu,
    });
    const codesearchTask = new ecs.FargateTaskDefinition(this, "CodesearchTask", {
      memoryLimitMiB: props.sizeProfile.tasks.codesearch.memoryLimitMiB,
      cpu: props.sizeProfile.tasks.codesearch.cpu,
    });

    if (props.resolvedModel.kind === "bedrock" && props.resolvedModel.taskRolePolicy) {
      backendTask.taskRole.addToPrincipalPolicy(props.resolvedModel.taskRolePolicy);
      workerTask.taskRole.addToPrincipalPolicy(props.resolvedModel.taskRolePolicy);
    }

    codesearchTask.addVolume({
      name: "codesearch-data",
      efsVolumeConfiguration: {
        fileSystemId: props.dataPlane.codesearchFileSystem.fileSystemId,
        transitEncryption: "ENABLED",
      },
    });

    backendTask.addContainer("backend", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/backend:${props.defaultImageTag}`,
      ),
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        AUTH_BASE_URL: appUrl,
        AUTH_ALLOWED_ORIGINS: appUrl,
        OTEL_SERVICE_NAME: "backend",
        GRAPH_DB_PROVIDER: "neptune",
        GRAPH_DB_URI: props.dataPlane.graphDbUri,
        [`GRAPH_DB_URI_${props.orgSlug}`]: props.dataPlane.graphDbUri,
        UI_PROXY_URL: "http://ui.ctxpipe.local:3002",
        CODESEARCH_URL: "http://codesearch.ctxpipe.local:3001",
        ...modelContainerConfig.environment,
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(props.secrets.authSecret, "AUTH_SECRET"),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          props.secrets.databaseUrlSecret,
          "DATABASE_URL",
        ),
        SMTP_CONNECTION_URL: ecs.Secret.fromSecretsManager(
          props.secrets.smtpSecret,
          "SMTP_CONNECTION_URL",
        ),
        EMAIL_FROM_ADDRESS: ecs.Secret.fromSecretsManager(
          props.secrets.smtpSecret,
          "EMAIL_FROM_ADDRESS",
        ),
        ...modelContainerConfig.secrets,
        ...props.secrets.connectorEnv,
      },
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-backend" }),
    });

    workerTask.addContainer("worker", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/worker:${props.defaultImageTag}`,
      ),
      environment: {
        NODE_ENV: "production",
        AUTH_BASE_URL: appUrl,
        AUTH_ALLOWED_ORIGINS: appUrl,
        GRAPH_DB_PROVIDER: "neptune",
        GRAPH_DB_URI: props.dataPlane.graphDbUri,
        [`GRAPH_DB_URI_${props.orgSlug}`]: props.dataPlane.graphDbUri,
        UI_PROXY_URL: "http://ui.ctxpipe.local:3002",
        CODESEARCH_URL: "http://codesearch.ctxpipe.local:3001",
        ...modelContainerConfig.environment,
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(props.secrets.authSecret, "AUTH_SECRET"),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          props.secrets.databaseUrlSecret,
          "DATABASE_URL",
        ),
        SMTP_CONNECTION_URL: ecs.Secret.fromSecretsManager(
          props.secrets.smtpSecret,
          "SMTP_CONNECTION_URL",
        ),
        EMAIL_FROM_ADDRESS: ecs.Secret.fromSecretsManager(
          props.secrets.smtpSecret,
          "EMAIL_FROM_ADDRESS",
        ),
        ...modelContainerConfig.secrets,
        ...props.secrets.connectorEnv,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-worker" }),
    });

    uiTask.addContainer("ui", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/ui:${props.defaultImageTag}`,
      ),
      environment: {
        NODE_ENV: "production",
        PORT: "3002",
        VITE_PUBLIC_API_URL: appUrl,
      },
      portMappings: [{ containerPort: 3002 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-ui" }),
    });

    const codesearchContainer = codesearchTask.addContainer("codesearch", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/codesearch:${props.defaultImageTag}`,
      ),
      environment: {
        NODE_ENV: "production",
        PORT: "3001",
        AUTH_TOKEN_AUDIENCE_CODESEARCH: "codesearch",
        ZOEKT_WEBSERVER_URL: "http://127.0.0.1:6070",
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(props.secrets.authSecret, "AUTH_SECRET"),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          props.secrets.databaseUrlSecret,
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
      memoryLimitMiB: props.sizeProfile.tasks.migrate.memoryLimitMiB,
      cpu: props.sizeProfile.tasks.migrate.cpu,
    });
    migrateTask.addContainer("migrate", {
      image: ecs.ContainerImage.fromRegistry(
        `ghcr.io/ctxpipe-ai/backend:${props.defaultImageTag}`,
      ),
      command: ["bun", "run", "apps/backend/src/db/migrate.ts"],
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(props.secrets.authSecret, "AUTH_SECRET"),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          props.secrets.databaseUrlSecret,
          "DATABASE_URL",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-migrate" }),
    });

    this.grantTaskSecrets(backendTask, [
      props.secrets.authSecret,
      props.secrets.databaseUrlSecret,
      props.secrets.modelProviderSecret,
      props.secrets.smtpSecret,
      props.secrets.connectorSecret,
    ]);
    this.grantTaskSecrets(workerTask, [
      props.secrets.authSecret,
      props.secrets.databaseUrlSecret,
      props.secrets.modelProviderSecret,
      props.secrets.smtpSecret,
      props.secrets.connectorSecret,
    ]);
    this.grantTaskSecrets(codesearchTask, [
      props.secrets.authSecret,
      props.secrets.databaseUrlSecret,
    ]);
    this.grantTaskSecrets(migrateTask, [
      props.secrets.authSecret,
      props.secrets.databaseUrlSecret,
    ]);

    this.resources = {
      backendTask,
      workerTask,
      uiTask,
      codesearchTask,
      migrateTask,
    };
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
}
