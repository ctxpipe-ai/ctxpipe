import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as efs from "aws-cdk-lib/aws-efs";
import * as neptune from "aws-cdk-lib/aws-neptune";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { DataPlaneConstructProps, DataPlaneResources } from "./contracts";

export class DataPlaneConstruct extends Construct {
  public readonly resources: DataPlaneResources;

  public constructor(scope: Construct, id: string, props: DataPlaneConstructProps) {
    super(scope, id);

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
      defaultDatabaseName: props.defaults.databaseName,
      writer: rds.ClusterInstance.provisioned("writer", {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      }),
      backup: {
        retention: cdk.Duration.days(props.defaults.backupRetentionDays),
      },
      vpc: props.networking.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [props.networking.dbSecurityGroup],
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const neptuneSubnetGroup = new neptune.CfnDBSubnetGroup(this, "NeptuneSubnetGroup", {
      dbSubnetGroupDescription: "Private subnets for ctxpipe neptune",
      subnetIds: props.networking.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }).subnetIds,
    });

    const neptuneCluster = new neptune.CfnDBCluster(this, "Neptune", {
      dbSubnetGroupName: neptuneSubnetGroup.ref,
      vpcSecurityGroupIds: [props.networking.neptuneSecurityGroup.securityGroupId],
      backupRetentionPeriod: props.defaults.backupRetentionDays,
      storageEncrypted: true,
      iamAuthEnabled: false,
    });
    neptuneCluster.applyRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);
    const neptuneInstance = new neptune.CfnDBInstance(this, "NeptuneInstance", {
      dbClusterIdentifier: neptuneCluster.ref,
      dbInstanceClass: "db.t4g.medium",
    });
    neptuneInstance.applyRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);

    const codesearchFileSystem = new efs.FileSystem(this, "CodesearchEfs", {
      vpc: props.networking.vpc,
      encrypted: true,
      securityGroup: props.networking.efsSecurityGroup,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    });

    const graphDbUri = cdk.Fn.join("", ["bolt+s://", neptuneCluster.attrEndpoint, ":8182"]);

    this.resources = {
      dbCluster,
      dbCredentialsSecret,
      neptuneCluster,
      neptuneInstance,
      codesearchFileSystem,
      graphDbUri,
    };
  }
}
