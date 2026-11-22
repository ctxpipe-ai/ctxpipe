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
 * id, so a replacement host overwrites it. Gives `role` the permission for
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
  // Cloud Map writes the DNS record with its own permissions, not with the
  // caller's: the host needs no Route 53 or EC2 action. This grant on the
  // host's own service is what keeps a host to its own name.
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ["servicediscovery:RegisterInstance"],
      resources: [service.serviceArn],
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
      ]),
      installLatestAwsSdk: false,
    },
  )

  return {
    service,
    hostname: `${name}.${namespace.namespaceName}`,
    deregistration,
  }
}
