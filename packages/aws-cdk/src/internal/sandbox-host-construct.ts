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
import { CHAT_SANDBOX_BUILD_FILES, CHAT_SANDBOX_IMAGE } from "../chat-sandbox-image";
import type {
  SandboxHostConstructProps,
  SandboxHostResources,
} from "./contracts";

const DOCKER_TLS_PORT = 2376;
/**
 * Linux ephemeral range on both sides: Docker publishes sandbox ports from it
 * on the host, and the backend's per-run tool bridges listen on port 0.
 */
const EPHEMERAL_PORTS = ec2.Port.tcpRange(32768, 60999);
const BACKEND_PORT = 3000;
/** One fixed Cloud Map instance: a replacement host overwrites the record. */
const DISCOVERY_INSTANCE_ID = "sandbox-host";
const CLIENT_CERT_PATH = "/tmp/ctxpipe-docker-tls";

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
      // pulls base images and packages. Data stores only admit the app group.
      allowAllOutbound: true,
    });
    const clientSecurityGroup = new ec2.SecurityGroup(this, "ClientSecurityGroup", {
      vpc,
      description: "ctxpipe backend and worker: sandbox host clients",
      // Egress comes from the app security group these tasks also carry.
      allowAllOutbound: false,
    });
    hostSecurityGroup.addIngressRule(
      clientSecurityGroup,
      ec2.Port.tcp(DOCKER_TLS_PORT),
      "Docker API (mutual TLS) from backend and worker",
    );
    hostSecurityGroup.addIngressRule(
      clientSecurityGroup,
      EPHEMERAL_PORTS,
      "Published sandbox agent ports from backend",
    );
    clientSecurityGroup.addIngressRule(
      hostSecurityGroup,
      ec2.Port.tcp(BACKEND_PORT),
      "Model proxy from sandboxes",
    );
    clientSecurityGroup.addIngressRule(
      hostSecurityGroup,
      EPHEMERAL_PORTS,
      "Per-run tool bridges from sandboxes",
    );

    // Filled by the host on first boot and reused by every replacement host,
    // so running tasks keep trusting the daemon. The CA key is never stored.
    const serverTlsSecret = new secretsmanager.Secret(this, "ServerTlsSecret", {
      description: "ctxpipe sandbox host: Docker daemon TLS (written by the host)",
      secretStringValue: cdk.SecretValue.unsafePlainText("{}"),
    });
    const clientTlsSecret = new secretsmanager.Secret(this, "ClientTlsSecret", {
      description: "ctxpipe sandbox host: Docker client TLS for backend and worker (written by the host)",
      secretStringValue: cdk.SecretValue.unsafePlainText("{}"),
    });

    const discovery = new servicediscovery.Service(this, "Discovery", {
      namespace,
      name: "sandbox-host",
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
    });
    const dockerHostname = `sandbox-host.${namespace.namespaceName}`;

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

    const architecture = props.instanceType.architecture;
    const userData = ec2.UserData.forLinux();
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: props.instanceType,
      // Resolved when an instance launches, not at deploy: a new AMI release
      // does not replace the host on the next `cdk deploy`, and every
      // replacement host boots the latest one.
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${
          architecture === ec2.InstanceArchitecture.ARM_64 ? "arm64" : "x86_64"
        }`,
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
      // The host signals once Docker, TLS, and the chat image are ready, so a
      // deploy fails instead of leaving chat without a sandbox host.
      signals: autoscaling.Signals.waitForAll({ timeout: cdk.Duration.minutes(30) }),
      // A changed image, chat build context, or AMI replaces the one host.
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
      clientSecurityGroup,
      clientTlsSecret,
      alarms: [diskAlarm, memoryAlarm],
      environment: {
        SANDBOX_PROVIDER: "docker",
        SANDBOX_CHAT_IMAGE: CHAT_SANDBOX_IMAGE,
        DOCKER_HOST: `tcp://${dockerHostname}:${DOCKER_TLS_PORT}`,
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: CLIENT_CERT_PATH,
      },
      // Read by the container entrypoint only; it writes them to
      // DOCKER_CERT_PATH (dockerode reads files) and unsets them.
      secrets: {
        SANDBOX_HOST_TLS_CA: ecs.Secret.fromSecretsManager(clientTlsSecret, "ca"),
        SANDBOX_HOST_TLS_CERT: ecs.Secret.fromSecretsManager(clientTlsSecret, "cert"),
        SANDBOX_HOST_TLS_KEY: ecs.Secret.fromSecretsManager(clientTlsSecret, "key"),
      },
    };
  }
}

/**
 * Container command for a sandbox host client. Writes the Docker client
 * certificates, and for the backend sets `SANDBOX_CALLBACK_HOST` to this
 * task's own IP: sandboxes call the model proxy and the per-run tool bridge
 * in the process that runs the turn, so a shared service name could reach the
 * wrong replica.
 */
export function sandboxHostClientCommand(
  start: string,
  options: { readonly callbackHost: boolean },
): { entryPoint: string[]; command: string[] } {
  const lines = [
    "set -eu",
    "umask 077",
    'mkdir -p "$DOCKER_CERT_PATH"',
    `printf '%s\\n' "$SANDBOX_HOST_TLS_CA" > "$DOCKER_CERT_PATH/ca.pem"`,
    `printf '%s\\n' "$SANDBOX_HOST_TLS_CERT" > "$DOCKER_CERT_PATH/cert.pem"`,
    `printf '%s\\n' "$SANDBOX_HOST_TLS_KEY" > "$DOCKER_CERT_PATH/key.pem"`,
    "unset SANDBOX_HOST_TLS_CA SANDBOX_HOST_TLS_CERT SANDBOX_HOST_TLS_KEY",
  ];
  if (options.callbackHost) {
    lines.push(
      `SANDBOX_CALLBACK_HOST="$(bun -e 'fetch(process.env.ECS_CONTAINER_METADATA_URI_V4).then((r) => r.json()).then((m) => console.log(m.Networks[0].IPv4Addresses[0]))')"`,
      'test -n "$SANDBOX_CALLBACK_HOST"',
      "export SANDBOX_CALLBACK_HOST",
    );
  }
  lines.push(`exec ${start}`);
  return { entryPoint: ["/bin/sh", "-c"], command: [lines.join("\n")] };
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
}

/**
 * Boot script for Amazon Linux 2023. Formats and mounts the Docker volume,
 * creates or reuses the TLS material, configures the daemon (TLS on 2376, all
 * sandboxes under one capped slice, log rotation), builds the chat image for
 * this architecture, registers the Cloud Map name, then signals CloudFormation.
 */
function hostBootstrapScript(input: HostBootstrapInput): string[] {
  const buildFiles = Object.entries(CHAT_SANDBOX_BUILD_FILES).map(
    ([name, content]) =>
      `printf '%s' '${Buffer.from(content).toString("base64")}' | base64 -d > "/opt/ctxpipe/chat-sandbox/${name}"`,
  );
  return [
    // Output lands in /var/log/cloud-init-output.log.
    "set -euo pipefail",
    `REGION='${input.region}'`,
    `DOCKER_HOSTNAME='${input.dockerHostname}'`,
    `CHAT_IMAGE='${CHAT_SANDBOX_IMAGE}'`,
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
    `aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.serverTlsSecretArn}' --query SecretString --output text > "$WORK/server.json"`,
    `aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.clientTlsSecretArn}' --query SecretString --output text > "$WORK/client.json"`,
    'if [ -z "$(jq -r ".key // empty" "$WORK/server.json")" ] || [ -z "$(jq -r ".key // empty" "$WORK/client.json")" ]; then',
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
        // Each sandbox's agent port is unauthenticated: sandboxes must not
        // reach each other over the bridge.
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
    "# Sandboxes never reach the host itself (other sandboxes' published ports, the",
    "# Docker API) or instance metadata (next to the IMDS hop limit). Fails closed.",
    "ExecStartPost=/bin/sh -c 'iptables -C INPUT -i docker0 -j REJECT 2>/dev/null || iptables -I INPUT -i docker0 -j REJECT'",
    "ExecStartPost=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254/32 -j REJECT'",
    "UNIT",
    "systemctl daemon-reload",
    "systemctl enable --now docker",

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

    "# Workspace chat image, built for this host's architecture.",
    "install -d /opt/ctxpipe/chat-sandbox",
    ...buildFiles,
    'docker image inspect "$CHAT_IMAGE" >/dev/null 2>&1 || docker build -t "$CHAT_IMAGE" /opt/ctxpipe/chat-sandbox',
    "docker image prune -f",

    "# Prove the TLS endpoint with the client certificate before taking the name.",
    'jq -r .ca "$WORK/client.json" > "$WORK/client-ca.pem"',
    'jq -r .cert "$WORK/client.json" > "$WORK/client-cert.pem"',
    'jq -r .key "$WORK/client.json" > "$WORK/client-key.pem"',
    `curl -sf --retry 10 --retry-connrefused --resolve "$DOCKER_HOSTNAME:${DOCKER_TLS_PORT}:127.0.0.1" --cacert "$WORK/client-ca.pem" --cert "$WORK/client-cert.pem" --key "$WORK/client-key.pem" "https://$DOCKER_HOSTNAME:${DOCKER_TLS_PORT}/_ping"`,
    'rm -rf "$WORK"',
    `aws servicediscovery register-instance --region "$REGION" --service-id '${input.discoveryServiceId}' --instance-id '${DISCOVERY_INSTANCE_ID}' --attributes "AWS_INSTANCE_IPV4=$PRIVATE_IP"`,
    "signal SUCCESS",
  ];
}
