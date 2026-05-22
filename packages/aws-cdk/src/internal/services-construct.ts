import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Construct } from "constructs";
import type { ServiceResources, ServicesConstructProps } from "./contracts";

export class ServicesConstruct extends Construct {
  public readonly resources: ServiceResources;

  public constructor(scope: Construct, id: string, props: ServicesConstructProps) {
    super(scope, id);

    const backendService = new ecs.FargateService(this, "BackendService", {
      cluster: props.networking.cluster,
      taskDefinition: props.tasks.backendTask,
      desiredCount: props.sizeProfile.services.backendDesiredCount,
      circuitBreaker: {
        rollback: true,
      },
      assignPublicIp: false,
      securityGroups: [props.networking.appSecurityGroup],
      cloudMapOptions: {
        name: "backend",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: props.networking.cluster,
      taskDefinition: props.tasks.workerTask,
      desiredCount: props.sizeProfile.services.workerDesiredCount,
      circuitBreaker: {
        rollback: true,
      },
      assignPublicIp: false,
      securityGroups: [props.networking.appSecurityGroup],
      cloudMapOptions: {
        name: "worker",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const uiService = new ecs.FargateService(this, "UiService", {
      cluster: props.networking.cluster,
      taskDefinition: props.tasks.uiTask,
      desiredCount: props.sizeProfile.services.uiDesiredCount,
      circuitBreaker: {
        rollback: true,
      },
      assignPublicIp: false,
      securityGroups: [props.networking.appSecurityGroup],
      cloudMapOptions: {
        name: "ui",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const codesearchService = new ecs.FargateService(this, "CodesearchService", {
      cluster: props.networking.cluster,
      taskDefinition: props.tasks.codesearchTask,
      desiredCount: props.sizeProfile.services.codesearchDesiredCount,
      circuitBreaker: {
        rollback: true,
      },
      assignPublicIp: false,
      securityGroups: [props.networking.appSecurityGroup],
      cloudMapOptions: {
        name: "codesearch",
      },
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    if (props.migrateDependency) {
      backendService.node.addDependency(props.migrateDependency);
      workerService.node.addDependency(props.migrateDependency);
      uiService.node.addDependency(props.migrateDependency);
      codesearchService.node.addDependency(props.migrateDependency);
    }

    this.resources = {
      backendService,
      workerService,
      uiService,
      codesearchService,
    };
  }
}
