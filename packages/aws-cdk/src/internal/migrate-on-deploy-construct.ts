import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import type {
  MigrateOnDeployConstructProps,
  MigrateOnDeployResources,
} from "./contracts";

const PROVIDER_FUNCTION_TIMEOUT_SECONDS = 900;

export class MigrateOnDeployConstruct extends Construct {
  public readonly resources: MigrateOnDeployResources;

  public constructor(scope: Construct, id: string, props: MigrateOnDeployConstructProps) {
    super(scope, id);

    const onEventHandler = new lambda.Function(this, "MigrateOnEvent", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.onEvent",
      timeout: cdk.Duration.seconds(PROVIDER_FUNCTION_TIMEOUT_SECONDS),
      code: lambda.Code.fromInline(
        `
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");

exports.onEvent = async (event) => {
  if (event.RequestType === "Delete") {
    return {
      PhysicalResourceId: event.PhysicalResourceId || "ctxpipe-migrate",
      Data: { Skipped: "true" },
    };
  }

  const properties = event.ResourceProperties;
  const ecs = new ECSClient({});
  const runTaskResponse = await ecs.send(
    new RunTaskCommand({
      cluster: properties.ClusterArn,
      taskDefinition: properties.TaskDefinitionArn,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: properties.SubnetIds,
          securityGroups: properties.SecurityGroupIds,
          assignPublicIp: "DISABLED",
        },
      },
    }),
  );

  if (!runTaskResponse.tasks || runTaskResponse.tasks.length === 0) {
    const failures = (runTaskResponse.failures || []).map((failure) => ({
      arn: failure.arn,
      reason: failure.reason,
      detail: failure.detail,
    }));
    throw new Error("Failed to start migration task: " + JSON.stringify(failures));
  }

  const taskArn = runTaskResponse.tasks[0].taskArn;
  if (!taskArn) {
    throw new Error("Migration task started without task ARN");
  }

  return {
    PhysicalResourceId: "ctxpipe-migrate",
    Data: {
      ClusterArn: properties.ClusterArn,
      TaskArn: taskArn,
    },
  };
};
        `,
      ),
    });

    const isCompleteHandler = new lambda.Function(this, "MigrateIsComplete", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.isComplete",
      timeout: cdk.Duration.seconds(PROVIDER_FUNCTION_TIMEOUT_SECONDS),
      code: lambda.Code.fromInline(
        `
const { ECSClient, DescribeTasksCommand } = require("@aws-sdk/client-ecs");

exports.isComplete = async (event) => {
  if (event.RequestType === "Delete") {
    return { IsComplete: true };
  }

  const clusterArn = event.Data.ClusterArn;
  const taskArn = event.Data.TaskArn;
  if (!clusterArn || !taskArn) {
    throw new Error("Missing migration task identifiers");
  }

  const ecs = new ECSClient({});
  const describeResponse = await ecs.send(
    new DescribeTasksCommand({
      cluster: clusterArn,
      tasks: [taskArn],
    }),
  );

  if (describeResponse.failures && describeResponse.failures.length > 0) {
    throw new Error("Failed to describe migration task: " + JSON.stringify(describeResponse.failures));
  }

  const task = describeResponse.tasks && describeResponse.tasks[0];
  if (!task) {
    throw new Error("Migration task not found in DescribeTasks");
  }

  if (task.lastStatus !== "STOPPED") {
    return { IsComplete: false };
  }

  const nonZeroExitContainer = (task.containers || []).find((container) => (container.exitCode || 0) !== 0);
  if (nonZeroExitContainer) {
    throw new Error(
      "Migration task failed: " +
        JSON.stringify({
          stoppedReason: task.stoppedReason,
          stopCode: task.stopCode,
          containerName: nonZeroExitContainer.name,
          exitCode: nonZeroExitContainer.exitCode,
          reason: nonZeroExitContainer.reason,
        }),
    );
  }

  return {
    IsComplete: true,
    Data: {
      StoppedReason: task.stoppedReason || "COMPLETED",
    },
  };
};
        `,
      ),
    });

    const passRoleArns = [
      props.tasks.migrateTask.taskRole.roleArn,
      props.tasks.migrateTask.executionRole?.roleArn,
    ].filter((arn): arn is string => arn !== undefined);

    onEventHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [props.tasks.migrateTask.taskDefinitionArn],
      }),
    );
    onEventHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: passRoleArns,
      }),
    );
    isCompleteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        resources: ["*"],
      }),
    );

    const provider = new cr.Provider(this, "MigrateProvider", {
      onEventHandler,
      isCompleteHandler,
      queryInterval: cdk.Duration.seconds(10),
      totalTimeout: cdk.Duration.seconds(PROVIDER_FUNCTION_TIMEOUT_SECONDS),
    });

    const migrateResource = new cdk.CustomResource(this, "RunMigrations", {
      serviceToken: provider.serviceToken,
      serviceTimeout: cdk.Duration.seconds(PROVIDER_FUNCTION_TIMEOUT_SECONDS),
      properties: {
        ClusterArn: props.networking.cluster.clusterArn,
        TaskDefinitionArn: props.tasks.migrateTask.taskDefinitionArn,
        SubnetIds: props.networking.vpc
          .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds,
        SecurityGroupIds: [props.networking.appSecurityGroup.securityGroupId],
      },
    });

    migrateResource.node.addDependency(props.dataPlane.dbCluster);
    migrateResource.node.addDependency(props.secrets.databaseUrlSecret);

    this.resources = {
      migrateResource,
    };
  }
}
