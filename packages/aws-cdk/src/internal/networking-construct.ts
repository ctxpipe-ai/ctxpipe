import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import type {
  NetworkingConstructProps,
  NetworkingResources,
} from "./contracts";

export class NetworkingConstruct extends Construct {
  public readonly resources: NetworkingResources;

  public constructor(scope: Construct, id: string, props: NetworkingConstructProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: props.maxAzs,
      natGateways: props.natGateways,
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
    appSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(3002),
      "Allow ECS services to reach UI on 3002",
    );
    appSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(3001),
      "Allow ECS services to reach codesearch on 3001",
    );

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(5432),
      "Allow PostgreSQL from ECS services",
    );

    const neptuneSecurityGroup = new ec2.SecurityGroup(this, "NeptuneSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });
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

    this.resources = {
      vpc,
      appSecurityGroup,
      dbSecurityGroup,
      neptuneSecurityGroup,
      efsSecurityGroup,
      cluster,
      alb,
      httpListener,
    };
  }
}
