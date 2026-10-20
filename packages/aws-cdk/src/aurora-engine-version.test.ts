import * as cdk from "aws-cdk-lib"
import { Template } from "aws-cdk-lib/assertions"
import type * as rds from "aws-cdk-lib/aws-rds"
import { describe, expect, it } from "vitest"
import { CtxPipe } from "./ctxpipe"

type CfnResource = {
  Type: string
  Properties?: Record<string, unknown>
  DependsOn?: unknown
  UpdateReplacePolicy?: string
  DeletionPolicy?: string
}

function rdsResources(
  customize?: (ctxpipe: CtxPipe) => void,
): Record<string, CfnResource> {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  })
  const ctxpipe = new CtxPipe(stack, "CtxPipe", {
    orgSlug: "acme",
    customDomain: {
      domainName: "app.example.com",
      hostedZoneId: "Z0123456789ABCDEF",
    },
    modelProvider: {
      kind: "bedrock",
      models: { fast: "openai.gpt-5.5" },
    },
  })
  customize?.(ctxpipe)
  const resources = Template.fromStack(stack).toJSON().Resources as Record<
    string,
    CfnResource
  >
  return Object.fromEntries(
    Object.entries(resources).filter(([, resource]) =>
      resource.Type.startsWith("AWS::RDS::"),
    ),
  )
}

function secretField(field: string): unknown {
  return {
    "Fn::Join": [
      "",
      [
        "{{resolve:secretsmanager:",
        { Ref: "CtxPipeDataPlaneDatabaseCredentialsSecret24FC0B2C" },
        `:SecretString:${field}::}}`,
      ],
    ],
  }
}

// The Aurora resources that @ctxpipe/aws-cdk 3.3.0 synthesized, without
// EngineVersion. A change to a logical id or to one of these properties can
// make CloudFormation replace the cluster on upgrade, which deletes the data.
const AURORA_RESOURCES_3_3_0: Record<string, CfnResource> = {
  CtxPipeDataPlaneDatabaseSubnetsD6C124A0: {
    Type: "AWS::RDS::DBSubnetGroup",
    Properties: {
      DBSubnetGroupDescription: "Subnets for Database database",
      SubnetIds: [
        { Ref: "CtxPipeNetworkingVpcprivateSubnet1SubnetB5ED70CE" },
        { Ref: "CtxPipeNetworkingVpcprivateSubnet2Subnet9A94315F" },
      ],
    },
  },
  CtxPipeDataPlaneDatabaseF6608C64: {
    Type: "AWS::RDS::DBCluster",
    Properties: {
      BackupRetentionPeriod: 7,
      CopyTagsToSnapshot: true,
      DBClusterParameterGroupName: "default.aurora-postgresql16",
      DBSubnetGroupName: { Ref: "CtxPipeDataPlaneDatabaseSubnetsD6C124A0" },
      DatabaseName: "ctxpipe",
      Engine: "aurora-postgresql",
      MasterUserPassword: secretField("password"),
      MasterUsername: secretField("username"),
      Port: 5432,
      StorageEncrypted: true,
      VpcSecurityGroupIds: [
        {
          "Fn::GetAtt": ["CtxPipeNetworkingDbSecurityGroupF26F881F", "GroupId"],
        },
      ],
    },
    UpdateReplacePolicy: "Snapshot",
    DeletionPolicy: "Snapshot",
  },
  CtxPipeDataPlaneDatabasewriter466CBE0A: {
    Type: "AWS::RDS::DBInstance",
    Properties: {
      DBClusterIdentifier: { Ref: "CtxPipeDataPlaneDatabaseF6608C64" },
      DBInstanceClass: "db.t4g.medium",
      Engine: "aurora-postgresql",
      PromotionTier: 0,
      PubliclyAccessible: false,
    },
    DependsOn: [
      "CtxPipeNetworkingVpcprivateSubnet1DefaultRoute7B9E0CBE",
      "CtxPipeNetworkingVpcprivateSubnet1RouteTableAssociationB29BC9D7",
      "CtxPipeNetworkingVpcprivateSubnet2DefaultRoute8EDCD1D5",
      "CtxPipeNetworkingVpcprivateSubnet2RouteTableAssociationB0A22444",
    ],
    UpdateReplacePolicy: "Delete",
    DeletionPolicy: "Delete",
  },
}

describe("Aurora engine version", () => {
  it("pins the AWS default Aurora PostgreSQL 16 minor and keeps major 16", () => {
    const cluster = rdsResources().CtxPipeDataPlaneDatabaseF6608C64

    expect(cluster?.Properties?.EngineVersion).toBe("16.13")
    expect(cluster?.Properties?.DBClusterParameterGroupName).toBe(
      "default.aurora-postgresql16",
    )
  })

  it("leaves the writer on the cluster version with automatic minor upgrades on", () => {
    const writer = rdsResources().CtxPipeDataPlaneDatabasewriter466CBE0A

    expect(writer?.Properties).not.toHaveProperty("EngineVersion")
    expect(writer?.Properties).not.toHaveProperty("AutoMinorVersionUpgrade")
  })

  it("changes only EngineVersion against the 3.3.0 Aurora resources", () => {
    const current = Object.fromEntries(
      Object.entries(rdsResources()).map(([logicalId, resource]) => {
        const { EngineVersion: _engineVersion, ...properties } =
          resource.Properties ?? {}
        return [logicalId, { ...resource, Properties: properties }]
      }),
    )

    expect(current).toEqual(AURORA_RESOURCES_3_3_0)
  })

  it("lets an operator on a newer 16.x minor keep that minor (README escape hatch)", () => {
    const cluster = rdsResources((ctxpipe) => {
      const cfnCluster = ctxpipe.node
        .findChild("DataPlane")
        .node.findChild("Database").node.defaultChild as rds.CfnDBCluster
      cfnCluster.engineVersion = "16.15"
    }).CtxPipeDataPlaneDatabaseF6608C64

    expect(cluster?.Properties?.EngineVersion).toBe("16.15")
  })
})
