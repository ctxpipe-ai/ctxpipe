import * as cdk from "aws-cdk-lib"
import * as autoscaling from "aws-cdk-lib/aws-autoscaling"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as iam from "aws-cdk-lib/aws-iam"
import * as logs from "aws-cdk-lib/aws-logs"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager"
import { Construct } from "constructs"

import type {
  KnowledgeStoreConstructProps,
  KnowledgeStoreResources,
} from "./contracts"
import { hostDiscovery } from "./host-discovery"

/** The ClickHouse HTTP port: the only port that the clients reach. */
const CLICKHOUSE_PORT = 8123
/** The same server as Docker Compose (ADR-066 decision 8). */
const CLICKHOUSE_IMAGE =
  "clickhouse/clickhouse-server:26.10.6.18@sha256:9c55d8d8a77e03e1fd399d59e4d0a1c7a5e42df70098ff1c5d8bd18eb1a5d106"
/** The prefix of the cold parts in the bucket: the host reaches only it. */
const COLD_PREFIX = "clickhouse"
const DISCOVERY_INSTANCE_ID = "clickhouse-node"
/** The admin user. Only the migrate task and the image's entrypoint use it. */
const ADMIN_USER = "ctxpipe"
const DATABASE = "ctxpipe"

/**
 * The knowledge store (ADR-066 decision 10): one ClickHouse node on one
 * Graviton EC2 host in a private subnet. Hot parts and the cache of the cold
 * parts are on an encrypted EBS volume that outlives the host; cold parts are
 * on a private bucket. The backend, the worker and the migrate task reach
 * ClickHouse over HTTP at a Cloud Map name, and nothing else reaches it.
 *
 * The stack generates the passwords of the admin user and of the users
 * `ctxpipe_reader` (backend) and `ctxpipe_writer` (worker). The migrate task
 * makes the two users (ADR-066 decision 9).
 */
export class KnowledgeStoreConstruct extends Construct {
  public readonly resources: KnowledgeStoreResources

  public constructor(
    scope: Construct,
    id: string,
    props: KnowledgeStoreConstructProps,
  ) {
    super(scope, id)
    const { vpc, cluster } = props.networking

    const credentials = (logicalId: string, username: string) =>
      new secretsmanager.Secret(this, logicalId, {
        description: `ctxpipe knowledge store: ClickHouse user ${username}`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username }),
          generateStringKey: "password",
          // The password goes into CLICKHOUSE_URL as it is.
          excludePunctuation: true,
          passwordLength: 40,
        },
      })
    const adminCredentialsSecret = credentials(
      "AdminCredentialsSecret",
      ADMIN_USER,
    )
    const readerCredentialsSecret = credentials(
      "ReaderCredentialsSecret",
      "ctxpipe_reader",
    )
    const writerCredentialsSecret = credentials(
      "WriterCredentialsSecret",
      "ctxpipe_writer",
    )

    const hostSecurityGroup = new ec2.SecurityGroup(this, "HostSecurityGroup", {
      vpc,
      description: "ctxpipe knowledge store: ClickHouse",
      // The host pulls its image and packages, and writes cold parts to S3.
      allowAllOutbound: true,
    })
    const clientSecurityGroup = new ec2.SecurityGroup(
      this,
      "ClientSecurityGroup",
      {
        vpc,
        description:
          "ctxpipe knowledge store clients: backend, worker and migrate",
        allowAllOutbound: false,
      },
    )
    hostSecurityGroup.addIngressRule(
      clientSecurityGroup,
      ec2.Port.tcp(CLICKHOUSE_PORT),
      "ClickHouse HTTP from backend, worker and migrate",
    )
    clientSecurityGroup.addEgressRule(
      hostSecurityGroup,
      ec2.Port.tcp(CLICKHOUSE_PORT),
      "ClickHouse HTTP",
    )

    const coldBucket = new s3.Bucket(this, "ColdBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The volume's metadata points at these parts.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
    })

    // The host and its volume must be in one zone: the first private subnet.
    const subnet = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets[0]
    if (!subnet) throw new Error("The knowledge store needs a private subnet")
    // Not on the launch template: a replacement host attaches this volume
    // again, so the data outlives the host.
    const dataVolume = new ec2.Volume(this, "DataVolume", {
      availabilityZone: subnet.availabilityZone,
      size: cdk.Size.gibibytes(props.dataVolumeSizeGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    })

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.TWO_WEEKS,
    })

    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        // Session Manager for operator checks; no SSH key or open port.
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    })
    adminCredentialsSecret.grantRead(role)
    logGroup.grantWrite(role)
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
        ],
        resources: [coldBucket.arnForObjects(`${COLD_PREFIX}/*`)],
      }),
    )
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [coldBucket.bucketArn],
        conditions: {
          StringLike: { "s3:prefix": [COLD_PREFIX, `${COLD_PREFIX}/*`] },
        },
      }),
    )
    // The host attaches the volume to itself, and only to an instance of its
    // own group (the tag below).
    const nodeTag = "ctxpipe:knowledge-store"
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ec2",
            resource: "volume",
            resourceName: dataVolume.volumeId,
          }),
        ],
      }),
    )
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:AttachVolume"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ec2",
            resource: "instance",
            resourceName: "*",
          }),
        ],
        conditions: {
          StringEquals: { [`aws:ResourceTag/${nodeTag}`]: this.node.addr },
        },
      }),
    )
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:SignalResource"],
        resources: [cdk.Stack.of(this).stackId],
      }),
    )
    const discovery = hostDiscovery(
      this,
      cluster,
      "clickhouse",
      DISCOVERY_INSTANCE_ID,
      role,
    )

    const userData = ec2.UserData.forLinux()
    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      instanceType: props.instanceType,
      // Resolved when an instance launches, not at deploy: a new AMI release
      // does not replace the host on the next `cdk deploy`.
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
      ),
      userData,
      role,
      securityGroup: hostSecurityGroup,
      // ClickHouse uses the host network, so hop limit 1 still gives it the
      // instance role for the bucket.
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
      ],
    })

    const autoScalingGroup = new autoscaling.AutoScalingGroup(
      this,
      "AutoScalingGroup",
      {
        vpc,
        vpcSubnets: { subnets: [subnet] },
        launchTemplate,
        minCapacity: 1,
        maxCapacity: 1,
        healthChecks: autoscaling.HealthChecks.ec2({
          gracePeriod: cdk.Duration.minutes(15),
        }),
        // The host signals once ClickHouse answers, so migrate finds it up.
        signals: autoscaling.Signals.waitForAll({
          timeout: cdk.Duration.minutes(30),
        }),
        // The old host goes first, so that its volume is free for the new one.
        updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
          maxBatchSize: 1,
          minInstancesInService: 0,
        }),
      },
    )
    cdk.Tags.of(autoScalingGroup).add(nodeTag, this.node.addr)
    autoScalingGroup.node.addDependency(discovery.deregistration)

    userData.addCommands(
      ...nodeBootstrapScript({
        region: cdk.Stack.of(this).region,
        stackName: cdk.Stack.of(this).stackName,
        autoScalingGroupLogicalId: cdk.Stack.of(this).getLogicalId(
          autoScalingGroup.node.defaultChild as cdk.CfnElement,
        ),
        dataVolumeId: dataVolume.volumeId,
        adminCredentialsSecretArn: adminCredentialsSecret.secretArn,
        logGroupName: logGroup.logGroupName,
        discoveryServiceId: discovery.service.serviceId,
        storageXml: storageXml({
          endpoint: `https://${coldBucket.bucketRegionalDomainName}/${COLD_PREFIX}/`,
          region: cdk.Stack.of(this).region,
          // A fifth of the volume: the cold parts that active Workspaces read.
          cacheSizeGiB: Math.floor(props.dataVolumeSizeGiB / 5),
        }),
      }),
    )

    this.resources = {
      autoScalingGroup,
      clientSecurityGroup,
      host: discovery.hostname,
      port: CLICKHOUSE_PORT,
      adminCredentialsSecret,
      readerCredentialsSecret,
      writerCredentialsSecret,
    }
  }
}

/**
 * The storage policy of `apps/backend/src/knowledge-store/clickhouse-storage.xml`
 * (volumes `hot` and `cold`), with `cold` on the bucket behind a cache disk on
 * the volume, as in the self-host docs ("Keep old parts on S3").
 */
function storageXml(input: {
  endpoint: string
  region: string
  cacheSizeGiB: number
}): string {
  return `<clickhouse>
  <storage_configuration>
    <disks>
      <cold_s3>
        <type>s3</type>
        <endpoint>${input.endpoint}</endpoint>
        <region>${input.region}</region>
        <!-- The instance role: no access key exists. -->
        <use_environment_credentials>true</use_environment_credentials>
      </cold_s3>
      <cold>
        <type>cache</type>
        <disk>cold_s3</disk>
        <!-- Relative: /var/lib/clickhouse/caches/cold/. Under disks/, the image makes the folder as root. -->
        <path>cold</path>
        <max_size>${input.cacheSizeGiB}Gi</max_size>
        <!-- The search reads small ranges of the vector column. -->
        <boundary_alignment>131072</boundary_alignment>
      </cold>
    </disks>
    <policies>
      <!-- Replaces the built-in default policy: the knowledge tables name no policy. -->
      <default>
        <volumes>
          <hot>
            <disk>default</disk>
          </hot>
          <cold>
            <disk>cold</disk>
            <perform_ttl_move_on_insert>0</perform_ttl_move_on_insert>
          </cold>
        </volumes>
        <!-- Under 20% free space on the volume, the largest parts move to the bucket. -->
        <move_factor>0.2</move_factor>
      </default>
    </policies>
  </storage_configuration>
</clickhouse>`
}

/**
 * Logs go to stdout (CloudWatch), not to files on the root disk. Of the
 * server's system logs, only `query_log` and `error_log` stay, for 7 days:
 * the others grow on the volume with no TTL.
 */
const LOGS_XML = `<clickhouse>
  <logger>
    <level>information</level>
    <console>1</console>
    <log remove="1"/>
    <errorlog remove="1"/>
  </logger>
${[
  "asynchronous_metric_log",
  "metric_log",
  "query_metric_log",
  "trace_log",
  "text_log",
  "processors_profile_log",
  "query_thread_log",
  "query_views_log",
  "part_log",
  "opentelemetry_span_log",
  "asynchronous_insert_log",
  "backup_log",
  "blob_storage_log",
  "s3queue_log",
]
  .map((table) => `  <${table} remove="1"/>`)
  .join("\n")}
  <query_log>
    <database>system</database>
    <table>query_log</table>
    <partition_by>event_date</partition_by>
    <ttl>event_date + INTERVAL 7 DAY DELETE</ttl>
  </query_log>
  <error_log>
    <database>system</database>
    <table>error_log</table>
    <partition_by>event_date</partition_by>
    <ttl>event_date + INTERVAL 7 DAY DELETE</ttl>
  </error_log>
</clickhouse>`

interface NodeBootstrapInput {
  readonly region: string
  readonly stackName: string
  readonly autoScalingGroupLogicalId: string
  readonly dataVolumeId: string
  readonly adminCredentialsSecretArn: string
  readonly logGroupName: string
  readonly discoveryServiceId: string
  readonly storageXml: string
}

/**
 * Boot script for Amazon Linux 2023. Attaches and mounts the data volume
 * (it formats only an empty volume), starts ClickHouse in Docker on the host
 * network, waits until it answers, registers the Cloud Map name, then signals
 * CloudFormation.
 */
function nodeBootstrapScript(input: NodeBootstrapInput): string[] {
  const configDir = "/etc/ctxpipe-clickhouse"
  return [
    // Output lands in /var/log/cloud-init-output.log.
    "set -euo pipefail",
    `REGION='${input.region}'`,
    `VOLUME_ID='${input.dataVolumeId}'`,
    'IMDS_TOKEN="$(curl -sfX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")"',
    'imds() { curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }',
    'INSTANCE_ID="$(imds instance-id)"',
    'PRIVATE_IP="$(imds local-ipv4)"',
    `signal() { aws cloudformation signal-resource --region "$REGION" --stack-name '${input.stackName}' --logical-resource-id '${input.autoScalingGroupLogicalId}' --unique-id "$INSTANCE_ID" --status "$1"; }`,
    "trap 'signal FAILURE' ERR",

    "# The data volume. The volume of a replaced host comes free when that host stops.",
    "for _ in $(seq 1 60); do",
    '  aws ec2 attach-volume --region "$REGION" --volume-id "$VOLUME_ID" --instance-id "$INSTANCE_ID" --device /dev/xvdf >/dev/null && break',
    "  sleep 5",
    "done",
    // oxlint-disable-next-line no-template-curly-in-string -- a bash expansion
    'DATA_DISK="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUME_ID/-/}"',
    "for _ in $(seq 1 60); do",
    '  [ -e "$DATA_DISK" ] && break',
    "  sleep 2",
    "done",
    "# mkfs.xfs refuses a volume that has a file system: this never formats data.",
    'blkid "$DATA_DISK" >/dev/null || mkfs.xfs -q "$DATA_DISK"',
    "mkdir -p /var/lib/clickhouse",
    'grep -q " /var/lib/clickhouse " /etc/fstab || echo "UUID=$(blkid -s UUID -o value "$DATA_DISK") /var/lib/clickhouse xfs defaults,nofail 0 2" >> /etc/fstab',
    "mountpoint -q /var/lib/clickhouse || mount /var/lib/clickhouse",
    "# A larger volume from a new size profile.",
    "xfs_growfs /var/lib/clickhouse >/dev/null",

    "dnf install -y docker jq",
    "systemctl enable --now docker",

    `install -d -m 755 ${configDir}`,
    `cat > ${configDir}/storage.xml <<'XML'`,
    input.storageXml,
    "XML",
    `cat > ${configDir}/logs.xml <<'XML'`,
    LOGS_XML,
    "XML",

    "# The image's entrypoint makes the admin user (with SQL access management)",
    "# and the database, as in Docker Compose. The password stays off the command line.",
    `CLICKHOUSE_PASSWORD="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id '${input.adminCredentialsSecretArn}' --query SecretString --output text | jq -r .password)"`,
    "export CLICKHOUSE_PASSWORD",
    "docker rm -f ctxpipe-clickhouse >/dev/null 2>&1 || true",
    [
      // A stopped host gives ClickHouse time to finish its writes.
      "docker run -d --name ctxpipe-clickhouse --restart unless-stopped --stop-timeout 120 --network host",
      "--ulimit nofile=262144:262144",
      `--log-driver awslogs --log-opt awslogs-region="$REGION" --log-opt awslogs-group='${input.logGroupName}'`,
      "-v /var/lib/clickhouse:/var/lib/clickhouse",
      `-v ${configDir}/storage.xml:/etc/clickhouse-server/config.d/storage.xml:ro`,
      `-v ${configDir}/logs.xml:/etc/clickhouse-server/config.d/logs.xml:ro`,
      `-e CLICKHOUSE_USER=${ADMIN_USER} -e CLICKHOUSE_PASSWORD -e CLICKHOUSE_DB=${DATABASE} -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1`,
      CLICKHOUSE_IMAGE,
    ].join(" "),
    "unset CLICKHOUSE_PASSWORD",
    "# ClickHouse checks the bucket when it starts, so this also proves the instance role.",
    `curl -sf --max-time 5 --retry 60 --retry-all-errors --retry-delay 2 http://127.0.0.1:${CLICKHOUSE_PORT}/ping`,

    `aws servicediscovery register-instance --region "$REGION" --service-id '${input.discoveryServiceId}' --instance-id '${DISCOVERY_INSTANCE_ID}' --attributes "AWS_INSTANCE_IPV4=$PRIVATE_IP"`,
    "signal SUCCESS",
  ]
}
