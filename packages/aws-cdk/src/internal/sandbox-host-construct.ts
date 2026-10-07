import * as cdk from "aws-cdk-lib";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import type {
  SandboxHostConstructProps,
  SandboxHostResources,
} from "./contracts";

const DOCKER_TLS_PORT = 2376;
/** Agent Vault's API (backend and worker) and proxy (sandboxes only). */
const AGENT_VAULT_API_PORT = 14321;
const AGENT_VAULT_PROXY_PORT = 14322;
/**
 * Linux ephemeral range on both sides: Docker publishes sandbox ports from it
 * on the host, and the backend's per-run tool bridges listen on port 0.
 */
const EPHEMERAL_PORTS = ec2.Port.tcpRange(32768, 60999);
/** One fixed Cloud Map instance: a replacement host overwrites the record. */
const DISCOVERY_INSTANCE_ID = "sandbox-host";

/**
 * One EC2 Docker host for Workspace chat sandboxes (stock TanStack
 * `dockerSandbox`). Backend and worker reach its Docker API over mutual TLS
 * at a Cloud Map name that the host registers when it boots; sandboxes call
 * the backend task back on its own IP.
 */
export class SandboxHostConstruct extends Construct {
  public readonly resources: SandboxHostResources;

  public constructor(scope: Construct, id: string, props: SandboxHostConstructProps) {
    super(scope, id);
    const { vpc, cluster } = props.networking;
    const namespace = cluster.defaultCloudMapNamespace;
    if (!(namespace instanceof servicediscovery.PrivateDnsNamespace)) {
      throw new Error("The sandbox host needs the cluster's private DNS namespace");
    }

    const hostSecurityGroup = new ec2.SecurityGroup(this, "HostSecurityGroup", {
      vpc,
      description: "ctxpipe sandbox host",
      // Sandboxes clone from Git hosts and call the model proxy; the host
      // pulls images and packages. Data stores only admit the app group.
      allowAllOutbound: true,
    });
    // Egress for both comes from the app security group the tasks also carry.
    const backendSecurityGroup = new ec2.SecurityGroup(this, "BackendSecurityGroup", {
      vpc,
      description: "ctxpipe backend: sandbox host client and sandbox callbacks",
      allowAllOutbound: false,
    });
    const workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc,
      description: "ctxpipe worker: sandbox host client",
      allowAllOutbound: false,
    });
    for (const client of [backendSecurityGroup, workerSecurityGroup]) {
      hostSecurityGroup.addIngressRule(
        client,
        ec2.Port.tcp(DOCKER_TLS_PORT),
        "Docker API (mutual TLS)",
      );
      hostSecurityGroup.addIngressRule(
        client,
        ec2.Port.tcp(AGENT_VAULT_API_PORT),
        "Agent Vault API (run vaults)",
      );
    }
    hostSecurityGroup.addIngressRule(
      backendSecurityGroup,
      EPHEMERAL_PORTS,
      "Published sandbox agent ports from backend",
    );
    backendSecurityGroup.addIngressRule(
      hostSecurityGroup,
      ec2.Port.tcp(3000),
      "Model proxy from sandboxes",
    );
    backendSecurityGroup.addIngressRule(
      hostSecurityGroup,
      EPHEMERAL_PORTS,
      "Per-run tool bridges from sandboxes",
    );

    // Created with a CloudFormation-generated placeholder that CloudFormation
    // never rewrites; the first host replaces it and every replacement host
    // reuses it, so running tasks keep trusting the daemon. The CA key is
    // never stored.
    const serverTlsSecret = new secretsmanager.Secret(this, "ServerTlsSecret", {
      description: "ctxpipe sandbox host: Docker daemon TLS (written by the host)",
    });
    const clientTlsSecret = new secretsmanager.Secret(this, "ClientTlsSecret", {
      description: "ctxpipe sandbox host: Docker client TLS for backend and worker (written by the host)",
    });

    // Agent Vault adds sandbox credentials in flight. The stack generates
    // both passwords. Only the host reads the master password; backend and
    // worker log in as the owner (the first login registers it).
    const agentVaultMasterSecret = new secretsmanager.Secret(this, "AgentVaultMasterSecret", {
      description: "ctxpipe sandbox host: Agent Vault master password",
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const agentVaultOwnerSecret = new secretsmanager.Secret(this, "AgentVaultOwnerSecret", {
      description: "ctxpipe sandbox host: Agent Vault owner password for backend and worker",
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    const discovery = new servicediscovery.Service(this, "Discovery", {
      namespace,
      name: "sandbox-host",
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
    });
    const dockerHostname = `${discovery.serviceName}.${namespace.namespaceName}`;

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        // Session Manager for operator checks; no SSH key or open port.
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
      ],
    });
    serverTlsSecret.grantRead(role);
    serverTlsSecret.grantWrite(role);
    clientTlsSecret.grantRead(role);
    clientTlsSecret.grantWrite(role);
    agentVaultMasterSecret.grantRead(role);
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["servicediscovery:RegisterInstance"],
        resources: [discovery.serviceArn],
      }),
    );
    role.addToPrincipalPolicy(cloudMapRoute53Statement(namespace, ["route53:CreateHealthCheck"]));
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Cloud Map checks the registered instance; describe has no resource scope.
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:SignalResource"],
        resources: [cdk.Stack.of(this).stackId],
      }),
    );

    const userData = ec2.UserData.forLinux();
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: props.instanceType,
      // Resolved when an instance launches, not at deploy: a new AMI release
      // does not replace the host on the next `cdk deploy`, and every
      // replacement host boots the latest one.
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
      ),
      userData,
      role,
      securityGroup: hostSecurityGroup,
      // Hop limit 1 keeps instance credentials out of sandbox containers.
      requireImdsv2: true,
      httpPutResponseHopLimit: 1,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(16, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
        {
          deviceName: "/dev/xvdb",
          volume: ec2.BlockDeviceVolume.ebs(props.dockerVolumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, "AutoScalingGroup", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(15),
      }),
      // The host signals once Docker and TLS are ready, so a deploy fails
      // instead of leaving chat without a sandbox host.
      signals: autoscaling.Signals.waitForAll({ timeout: cdk.Duration.minutes(30) }),
      // A changed instance type, volume, or boot script replaces the one host.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
      }),
    });

    // Cloud Map refuses to delete a service with instances; the host registers
    // itself, so deregister after the host is gone and before the service goes.
    const deregistration = new cr.AwsCustomResource(this, "DiscoveryDeregistration", {
      onDelete: {
        service: "ServiceDiscovery",
        action: "deregisterInstance",
        parameters: {
          ServiceId: discovery.serviceId,
          InstanceId: DISCOVERY_INSTANCE_ID,
        },
        ignoreErrorCodesMatching: "InstanceNotFound|ServiceNotFound",
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["servicediscovery:DeregisterInstance"],
          resources: [discovery.serviceArn],
        }),
        cloudMapRoute53Statement(namespace, ["route53:DeleteHealthCheck"]),
      ]),
      installLatestAwsSdk: false,
    });
    autoScalingGroup.node.addDependency(deregistration);

    userData.addCommands(
      ...hostBootstrapScript({
        region: cdk.Stack.of(this).region,
        stackName: cdk.Stack.of(this).stackName,
        autoScalingGroupLogicalId: cdk.Stack.of(this).getLogicalId(
          autoScalingGroup.node.defaultChild as cdk.CfnElement,
        ),
        serverTlsSecretArn: serverTlsSecret.secretArn,
        clientTlsSecretArn: clientTlsSecret.secretArn,
        discoveryServiceId: discovery.serviceId,
        dockerHostname,
        agentVaultMasterSecretArn: agentVaultMasterSecret.secretArn,
        // The backend tasks' subnets. They are the stack's only private
        // subnets, so they also hold RDS, Neptune, EFS and the UI and
        // codesearch tasks. Only security groups keep the proxy out of them:
        // the sandbox host's group must never be in the app security group
        // or in their ingress rules. The host's own ports are rejected below.
        backendSubnetCidrs: vpc
          .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
          .subnets.map((subnet) => subnet.ipv4CidrBlock),
      }),
    );

    const dimensions = { AutoScalingGroupName: autoScalingGroup.autoScalingGroupName };
    const diskAlarm = new cloudwatch.Alarm(this, "DockerDiskAlarm", {
      alarmDescription:
        "ctxpipe sandbox host: /var/lib/docker is over 80% full. Check `docker system df` and stopped sandboxes.",
      metric: new cloudwatch.Metric({
        namespace: "CWAgent",
        metricName: "disk_used_percent",
        dimensionsMap: { ...dimensions, path: "/var/lib/docker" },
        statistic: cloudwatch.Stats.MAXIMUM,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    const memoryAlarm = new cloudwatch.Alarm(this, "MemoryAlarm", {
      alarmDescription:
        "ctxpipe sandbox host: memory is over 85% for 15 minutes. Sandboxes are near their cgroup cap; consider a larger sandboxHost.instanceType.",
      metric: new cloudwatch.Metric({
        namespace: "CWAgent",
        metricName: "mem_used_percent",
        dimensionsMap: dimensions,
        statistic: cloudwatch.Stats.AVERAGE,
        period: cdk.Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    this.resources = {
      autoScalingGroup,
      backendSecurityGroup,
      workerSecurityGroup,
      clientTlsSecret,
      dockerHost: `tcp://${dockerHostname}:${DOCKER_TLS_PORT}`,
      agentVaultAddress: `http://${dockerHostname}:${AGENT_VAULT_API_PORT}`,
      agentVaultOwnerSecret,
      alarms: [diskAlarm, memoryAlarm],
    };
  }
}

/**
 * Makes `app` a client of the sandbox host. A short init container writes the
 * Docker client certificates (dockerode reads files only) to a task volume
 * that `app` mounts read-only, so the image's own command runs unchanged and
 * the private key never enters the app's environment.
 */
export function addSandboxHostClient(
  task: ecs.FargateTaskDefinition,
  app: ecs.ContainerDefinition,
  /** The app's own image, already pulled for the task. */
  image: ecs.ContainerImage,
  host: SandboxHostResources,
): void {
  const certPath = "/run/ctxpipe-docker-tls";
  task.addVolume({ name: "docker-tls" });
  const certs = task.addContainer("docker-tls", {
    image,
    essential: false,
    entryPoint: ["/bin/sh", "-c"],
    command: [
      [
        "set -eu",
        "umask 077",
        `printf '%s\\n' "$CA" > ${certPath}/ca.pem`,
        `printf '%s\\n' "$CERT" > ${certPath}/cert.pem`,
        `printf '%s\\n' "$KEY" > ${certPath}/key.pem`,
      ].join("\n"),
    ],
    secrets: {
      CA: ecs.Secret.fromSecretsManager(host.clientTlsSecret, "ca"),
      CERT: ecs.Secret.fromSecretsManager(host.clientTlsSecret, "cert"),
      KEY: ecs.Secret.fromSecretsManager(host.clientTlsSecret, "key"),
    },
    logging: ecs.LogDrivers.awsLogs({ streamPrefix: "ctxpipe-docker-tls" }),
  });
  certs.addMountPoints({ sourceVolume: "docker-tls", containerPath: certPath, readOnly: false });
  app.addMountPoints({ sourceVolume: "docker-tls", containerPath: certPath, readOnly: true });
  app.addContainerDependencies({
    container: certs,
    condition: ecs.ContainerDependencyCondition.SUCCESS,
  });
  app.addEnvironment("SANDBOX_PROVIDER", "docker");
  app.addEnvironment("DOCKER_HOST", host.dockerHost);
  app.addEnvironment("DOCKER_TLS_VERIFY", "1");
  app.addEnvironment("DOCKER_CERT_PATH", certPath);
  // Docker sandboxes get credentials only through Agent Vault.
  app.addEnvironment("AGENT_VAULT_ADDR", host.agentVaultAddress);
  // Sandboxes call the backend task back by its VPC DNS name: Agent Vault
  // rules take host names. us-east-1 names differ from other regions.
  const usEast1 = new cdk.CfnCondition(app, "UsEast1Callback", {
    expression: cdk.Fn.conditionEquals(cdk.Aws.REGION, "us-east-1"),
  });
  app.addEnvironment(
    "SANDBOX_CALLBACK_DNS_SUFFIX",
    cdk.Fn.conditionIf(
      usEast1.logicalId,
      "ec2.internal",
      `${cdk.Aws.REGION}.compute.internal`,
    ).toString(),
  );
  app.addSecret(
    "AGENT_VAULT_OWNER_PASSWORD",
    ecs.Secret.fromSecretsManager(host.agentVaultOwnerSecret),
  );
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
  });
}

interface HostBootstrapInput {
  readonly region: string;
  readonly stackName: string;
  readonly autoScalingGroupLogicalId: string;
  readonly serverTlsSecretArn: string;
  readonly clientTlsSecretArn: string;
  readonly discoveryServiceId: string;
  readonly dockerHostname: string;
  readonly agentVaultMasterSecretArn: string;
  /** Agent Vault may dial these private addresses: the backend tasks. */
  readonly backendSubnetCidrs: string[];
}

/**
 * Boot script for Amazon Linux 2023. Formats and mounts the Docker volume,
 * creates or reuses the TLS material, configures the daemon (TLS on 2376, all
 * sandboxes under one capped slice, log rotation), registers the Cloud Map
 * name, then signals CloudFormation. Images are pulled by the backend.
 */
function hostBootstrapScript(input: HostBootstrapInput): string[] {
  return [
    // Output lands in /var/log/cloud-init-output.log.
    "set -euo pipefail",
    `REGION='${input.region}'`,
    `DOCKER_HOSTNAME='${input.dockerHostname}'`,
    'IMDS_TOKEN="$(curl -sfX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")"',
    'imds() { curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }',
    'INSTANCE_ID="$(imds instance-id)"',
    'PRIVATE_IP="$(imds local-ipv4)"',
    `signal() { aws cloudformation signal-resource --region "$REGION" --stack-name '${input.stackName}' --logical-resource-id '${input.autoScalingGroupLogicalId}' --unique-id "$INSTANCE_ID" --status "$1"; }`,
    "trap 'signal FAILURE' ERR",

    "# Docker volume: the second EBS disk, never the root disk.",
    'ROOT_DISK="/dev/$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")"',
    'DATA_DISK=""',
    "for _ in $(seq 1 60); do",
    '  if [ -e /dev/xvdb ]; then DATA_DISK="$(readlink -f /dev/xvdb)"; else DATA_DISK="$(lsblk -dpno NAME,TYPE | awk -v root="$ROOT_DISK" \'$2 == "disk" && $1 != root { print $1; exit }\')"; fi',
    '  [ -n "$DATA_DISK" ] && break',
    "  sleep 2",
    "done",
    'blkid "$DATA_DISK" >/dev/null || mkfs.xfs -q "$DATA_DISK"',
    "mkdir -p /var/lib/docker",
    'grep -q " /var/lib/docker " /etc/fstab || echo "UUID=$(blkid -s UUID -o value "$DATA_DISK") /var/lib/docker xfs defaults,nofail 0 2" >> /etc/fstab',
    "mountpoint -q /var/lib/docker || mount /var/lib/docker",

    "dnf install -y docker jq amazon-cloudwatch-agent",

    "# TLS: reuse what an earlier host stored; otherwise create it once.",
    "install -d -m 700 /etc/docker/tls",
    'WORK="$(mktemp -d)"',
    "# Private keys never outlive the script, whether it succeeds or fails.",
    `trap 'rm -rf "$WORK"' EXIT`,
    `aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.serverTlsSecretArn}' --query SecretString --output text > "$WORK/server.json"`,
    `aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.clientTlsSecretArn}' --query SecretString --output text > "$WORK/client.json"`,
    "# The CloudFormation placeholder is not JSON with a key.",
    `has_key() { jq -e '.key | strings' "$1" >/dev/null 2>&1; }`,
    'if ! has_key "$WORK/server.json" || ! has_key "$WORK/client.json"; then',
    '  ( cd "$WORK"',
    '    openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=ctxpipe sandbox host CA" -keyout ca-key.pem -out ca.pem',
    '    openssl req -newkey rsa:3072 -nodes -subj "/CN=$DOCKER_HOSTNAME" -keyout server-key.pem -out server.csr',
    '    printf "subjectAltName=DNS:%s\\nextendedKeyUsage=serverAuth\\n" "$DOCKER_HOSTNAME" > server.ext',
    "    openssl x509 -req -sha256 -days 3650 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile server.ext -out server-cert.pem",
    '    openssl req -newkey rsa:3072 -nodes -subj "/CN=ctxpipe-backend" -keyout client-key.pem -out client.csr',
    '    printf "extendedKeyUsage=clientAuth\\n" > client.ext',
    "    openssl x509 -req -sha256 -days 3650 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile client.ext -out client-cert.pem",
    "    jq -n --rawfile ca ca.pem --rawfile cert client-cert.pem --rawfile key client-key.pem '{ca: $ca, cert: $cert, key: $key}' > client.json",
    "    jq -n --rawfile ca ca.pem --rawfile cert server-cert.pem --rawfile key server-key.pem '{ca: $ca, cert: $cert, key: $key}' > server.json )",
    `  aws secretsmanager put-secret-value --region "$REGION" --secret-id '${input.clientTlsSecretArn}' --secret-string "file://$WORK/client.json"`,
    `  aws secretsmanager put-secret-value --region "$REGION" --secret-id '${input.serverTlsSecretArn}' --secret-string "file://$WORK/server.json"`,
    "fi",
    'jq -r .ca "$WORK/server.json" > /etc/docker/tls/ca.pem',
    'jq -r .cert "$WORK/server.json" > /etc/docker/tls/server-cert.pem',
    'jq -r .key "$WORK/server.json" > /etc/docker/tls/server-key.pem',
    "chmod 600 /etc/docker/tls/*.pem",

    "# All sandbox containers share one capped slice, leaving room for the OS and dockerd.",
    "cat > /etc/systemd/system/ctxpipe-sandboxes.slice <<'UNIT'",
    "[Unit]",
    "Description=ctxpipe sandbox containers",
    "[Slice]",
    "MemoryMax=85%",
    "TasksMax=8192",
    "CPUWeight=50",
    "UNIT",
    "cat > /etc/docker/daemon.json <<'JSON'",
    JSON.stringify(
      {
        tlsverify: true,
        tlscacert: "/etc/docker/tls/ca.pem",
        tlscert: "/etc/docker/tls/server-cert.pem",
        tlskey: "/etc/docker/tls/server-key.pem",
        "exec-opts": ["native.cgroupdriver=systemd"],
        "cgroup-parent": "ctxpipe-sandboxes.slice",
        // Agent ports are published for the backend, so anything that
        // reaches the host could reach them: sandboxes must not reach each
        // other over the bridge.
        icc: false,
        "log-driver": "json-file",
        "log-opts": { "max-size": "10m", "max-file": "3" },
        "live-restore": true,
      },
      null,
      2,
    ),
    "JSON",
    "install -d /etc/systemd/system/docker.service.d",
    "cat > /etc/systemd/system/docker.service.d/ctxpipe.conf <<'UNIT'",
    "[Service]",
    "ExecStart=",
    `ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:${DOCKER_TLS_PORT} --containerd=/run/containerd/containerd.sock $OPTIONS $DOCKER_STORAGE_OPTIONS $DOCKER_ADD_RUNTIMES`,
    "# Sandboxes never reach the host itself (other sandboxes' published agent",
    "# ports, the Docker API) or instance metadata (next to the IMDS hop limit). Fails closed.",
    "ExecStartPost=/bin/sh -c 'iptables -C INPUT -i docker0 -j REJECT 2>/dev/null || iptables -I INPUT -i docker0 -j REJECT'",
    "ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254/32 -j REJECT'",
    "# Sandboxes (docker0) reach only Agent Vault's proxy, published on the host",
    "# and forwarded to its own bridge: no direct internet, backend, VPC, or DNS.",
    "ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -i docker0 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -i docker0 -j REJECT'",
    `ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -i docker0 -o ctxpipe-av -p tcp --dport ${AGENT_VAULT_PROXY_PORT} -j RETURN 2>/dev/null || iptables -I DOCKER-USER 1 -i docker0 -o ctxpipe-av -p tcp --dport ${AGENT_VAULT_PROXY_PORT} -j RETURN'`,
    "ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null || iptables -I DOCKER-USER 1 -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN'",
    "# Agent Vault never reaches the host (its own management API on the host's",
    "# address, the Docker API) or itself back through a published port.",
    "ExecStartPost=/bin/sh -c 'iptables -C INPUT -i ctxpipe-av -j REJECT 2>/dev/null || iptables -I INPUT -i ctxpipe-av -j REJECT'",
    "ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -i ctxpipe-av -o ctxpipe-av -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -i ctxpipe-av -o ctxpipe-av -j REJECT'",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable --now docker",

    "# Agent Vault adds sandbox credentials in flight (ADR-049). It has its own",
    "# bridge, so the DOCKER-USER rules above tell it from sandboxes. It may dial",
    "# private addresses only in the backend's subnets; security groups keep the",
    "# data stores closed to this host. The login rate limit stays on; the proxy",
    "# tier is raised, because all sandboxes of a turn share one vault.",
    "docker network inspect ctxpipe-av >/dev/null 2>&1 || docker network create -o com.docker.network.bridge.name=ctxpipe-av ctxpipe-av",
    `AGENT_VAULT_MASTER_PASSWORD="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.agentVaultMasterSecretArn}' --query SecretString --output text)"`,
    "docker rm -f ctxpipe-agent-vault >/dev/null 2>&1 || true",
    `docker run -d --name ctxpipe-agent-vault --restart unless-stopped --network ctxpipe-av -p ${AGENT_VAULT_API_PORT}:${AGENT_VAULT_API_PORT} -p ${AGENT_VAULT_PROXY_PORT}:${AGENT_VAULT_PROXY_PORT} -v ctxpipe-agent-vault:/data -e AGENT_VAULT_MASTER_PASSWORD="$AGENT_VAULT_MASTER_PASSWORD" -e AGENT_VAULT_RATELIMIT_PROXY_RATE=200 -e AGENT_VAULT_RATELIMIT_PROXY_BURST=2000 -e AGENT_VAULT_RATELIMIT_PROXY_CONCURRENCY=256 -e AGENT_VAULT_TELEMETRY=false -e AGENT_VAULT_NETWORK_ALLOWLIST='${input.backendSubnetCidrs.join(",")}' infisical/agent-vault:latest`,
    "unset AGENT_VAULT_MASTER_PASSWORD",
    `curl -sf --retry 30 --retry-connrefused --retry-delay 2 http://127.0.0.1:${AGENT_VAULT_API_PORT}/health`,

    "# Disk and memory metrics for the CloudFormation alarms.",
    "cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'JSON'",
    JSON.stringify({
      agent: { metrics_collection_interval: 60, omit_hostname: true },
      metrics: {
        namespace: "CWAgent",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the CloudWatch agent's own placeholder.
        append_dimensions: { AutoScalingGroupName: "${aws:AutoScalingGroupName}" },
        aggregation_dimensions: [["AutoScalingGroupName", "path"]],
        metrics_collected: {
          disk: { measurement: ["used_percent"], resources: ["/var/lib/docker"], drop_device: true },
          mem: { measurement: ["used_percent"] },
        },
      },
    }),
    "JSON",
    "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json",

    "# Prove the TLS endpoint with the client certificate before taking the name.",
    'jq -r .ca "$WORK/client.json" > "$WORK/client-ca.pem"',
    'jq -r .cert "$WORK/client.json" > "$WORK/client-cert.pem"',
    'jq -r .key "$WORK/client.json" > "$WORK/client-key.pem"',
    `curl -sf --retry 10 --retry-connrefused --resolve "$DOCKER_HOSTNAME:${DOCKER_TLS_PORT}:127.0.0.1" --cacert "$WORK/client-ca.pem" --cert "$WORK/client-cert.pem" --key "$WORK/client-key.pem" "https://$DOCKER_HOSTNAME:${DOCKER_TLS_PORT}/_ping"`,
    `aws servicediscovery register-instance --region "$REGION" --service-id '${input.discoveryServiceId}' --instance-id '${DISCOVERY_INSTANCE_ID}' --attributes "AWS_INSTANCE_IPV4=$PRIVATE_IP"`,
    "signal SUCCESS",
  ];
}
