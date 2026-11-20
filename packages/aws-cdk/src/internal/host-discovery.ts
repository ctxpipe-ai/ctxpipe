import * as cdk from "aws-cdk-lib"
import type * as ecs from "aws-cdk-lib/aws-ecs"
import * as iam from "aws-cdk-lib/aws-iam"
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery"
import * as cr from "aws-cdk-lib/custom-resources"
import type { Construct } from "constructs"

interface HostDiscovery {
  readonly service: servicediscovery.Service
  /** `<name>.<namespace>`. */
  readonly hostname: string
  /**
   * Removes the host's record when the stack deletes the name. Make the
   * host's Auto Scaling group depend on it, so that the record goes after the
   * host.
   */
  readonly deregistration: cr.AwsCustomResource
}

/**
 * A Cloud Map name in the cluster's private DNS namespace that one EC2 host
 * registers for itself when it boots (`aws servicediscovery
 * register-instance` with `instanceId`). The record has one fixed instance
 * id, so a replacement host overwrites it. Gives `role` the permissions for
 * the registration.
 */
export function hostDiscovery(
  scope: Construct,
  cluster: ecs.Cluster,
  name: string,
  instanceId: string,
  role: iam.IRole,
): HostDiscovery {
  const namespace = cluster.defaultCloudMapNamespace
  if (!(namespace instanceof servicediscovery.PrivateDnsNamespace)) {
    throw new Error(
      `The ${name} host needs the cluster's private DNS namespace`,
    )
  }
  const service = new servicediscovery.Service(scope, "Discovery", {
    namespace,
    name,
    dnsRecordType: servicediscovery.DnsRecordType.A,
    dnsTtl: cdk.Duration.seconds(10),
  })
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["servicediscovery:RegisterInstance"],
      resources: [service.serviceArn],
    }),
  )
  role.addToPrincipalPolicy(
    cloudMapRoute53Statement(namespace, ["route53:CreateHealthCheck"]),
  )
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      // Cloud Map checks the registered instance; describe has no resource scope.
      actions: ["ec2:DescribeInstances"],
      resources: ["*"],
    }),
  )

  // Cloud Map refuses to delete a service with instances; the host registers
  // itself, so deregister after the host is gone and before the service goes.
  const deregistration = new cr.AwsCustomResource(
    scope,
    "DiscoveryDeregistration",
    {
      onDelete: {
        service: "ServiceDiscovery",
        action: "deregisterInstance",
        parameters: { ServiceId: service.serviceId, InstanceId: instanceId },
        ignoreErrorCodesMatching: "InstanceNotFound|ServiceNotFound",
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["servicediscovery:DeregisterInstance"],
          resources: [service.serviceArn],
        }),
        cloudMapRoute53Statement(namespace, ["route53:DeleteHealthCheck"]),
      ]),
      installLatestAwsSdk: false,
    },
  )

  return {
    service,
    hostname: `${service.serviceName}.${namespace.namespaceName}`,
    deregistration,
  }
}

/** Cloud Map writes the instance's DNS record with the caller's permissions. */
function cloudMapRoute53Statement(
  namespace: servicediscovery.PrivateDnsNamespace,
  healthCheckActions: string[],
): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: [
      "route53:ChangeResourceRecordSets",
      "route53:GetHealthCheck",
      "route53:UpdateHealthCheck",
      ...healthCheckActions,
    ],
    resources: [
      `arn:${cdk.Aws.PARTITION}:route53:::hostedzone/${namespace.namespaceHostedZoneId}`,
      `arn:${cdk.Aws.PARTITION}:route53:::healthcheck/*`,
    ],
  })
}
