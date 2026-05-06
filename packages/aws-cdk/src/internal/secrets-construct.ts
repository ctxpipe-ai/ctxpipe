import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ses from "aws-cdk-lib/aws-ses";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import type { SecretsConstructProps, SecretsResources } from "./contracts";

export class SecretsConstruct extends Construct {
  public readonly resources: SecretsResources;

  public constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id);

    const authSecret = new secretsmanager.Secret(this, "AuthSecret", {
      secretStringValue: props.authSecretValue,
    });

    const databaseUrl = cdk.Fn.join("", [
      "postgresql://ctxpipe:",
      props.dataPlane.dbCredentialsSecret.secretValueFromJson("password").toString(),
      "@",
      props.dataPlane.dbCluster.clusterEndpoint.hostname,
      ":",
      cdk.Token.asString(props.dataPlane.dbCluster.clusterEndpoint.port),
      "/",
      props.databaseName,
    ]);

    const databaseUrlSecret = new secretsmanager.Secret(this, "DatabaseUrlSecret", {
      secretObjectValue: {
        DATABASE_URL: cdk.SecretValue.unsafePlainText(databaseUrl),
      },
    });

    const modelProviderSecret = new secretsmanager.Secret(this, "ModelProviderSecret", {
      secretObjectValue: {
        API_KEY: props.modelProviderApiKey,
      },
    });

    const sesIdentity = new ses.CfnEmailIdentity(this, "SesIdentity", {
      emailIdentity: props.emailFromAddress,
    });

    const sesSmtpUser = new iam.User(this, "SesSmtpUser");
    sesSmtpUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      }),
    );

    const sesSmtpAccessKey = new iam.CfnAccessKey(this, "SesSmtpAccessKey", {
      userName: sesSmtpUser.userName,
    });

    const smtpPasswordFunction = new lambda.Function(this, "SesSmtpPasswordFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(15),
      code: lambda.Code.fromInline(`
          const crypto = require("crypto");
          function sign(key, message) {
            return crypto.createHmac("sha256", key).update(message, "utf8").digest();
          }
          function toSmtpPassword(secretAccessKey, region) {
            const kDate = sign("AWS4" + secretAccessKey, "11111111");
            const kRegion = sign(kDate, region);
            const kService = sign(kRegion, "ses");
            const kSigning = sign(kService, "aws4_request");
            const kMessage = sign(kSigning, "SendRawEmail");
            return Buffer.concat([Buffer.from([0x04]), kMessage]).toString("base64");
          }
          exports.handler = async (event) => {
            if (event.RequestType === "Delete") {
              return { PhysicalResourceId: event.PhysicalResourceId || "ses-smtp-config" };
            }
            const accessKeyId = event.ResourceProperties.AccessKeyId;
            const secretAccessKey = event.ResourceProperties.SecretAccessKey;
            const region = event.ResourceProperties.Region;
            const fromAddress = event.ResourceProperties.FromAddress;
            const smtpPassword = toSmtpPassword(secretAccessKey, region);
            const encodedUser = encodeURIComponent(accessKeyId);
            const encodedPass = encodeURIComponent(smtpPassword);
            return {
              PhysicalResourceId: "ses-smtp-config",
              Data: {
                SmtpConnectionUrl: "smtps://" + encodedUser + ":" + encodedPass + "@email-smtp." + region + ".amazonaws.com:465",
                EmailFromAddress: fromAddress
              }
            };
          };
        `),
    });

    const smtpProvider = new cr.Provider(this, "SesSmtpProvider", {
      onEventHandler: smtpPasswordFunction,
    });

    const smtpConfiguration = new cdk.CustomResource(this, "SesSmtpConfig", {
      serviceToken: smtpProvider.serviceToken,
      properties: {
        AccessKeyId: sesSmtpAccessKey.ref,
        SecretAccessKey: sesSmtpAccessKey.attrSecretAccessKey,
        Region: cdk.Stack.of(this).region,
        FromAddress: props.emailFromAddress,
      },
    });

    const smtpSecret = new secretsmanager.Secret(this, "SmtpSecret", {
      secretObjectValue: {
        SMTP_CONNECTION_URL: cdk.SecretValue.unsafePlainText(
          smtpConfiguration.getAttString("SmtpConnectionUrl"),
        ),
        EMAIL_FROM_ADDRESS: cdk.SecretValue.unsafePlainText(
          smtpConfiguration.getAttString("EmailFromAddress"),
        ),
      },
    });
    smtpSecret.node.addDependency(sesIdentity);

    const connectorSecret = props.connectorSecrets
      ? new secretsmanager.Secret(this, "ConnectorSecret", {
          secretObjectValue: {
            ...(props.connectorSecrets.githubAppId
              ? { GITHUB_APP_ID: props.connectorSecrets.githubAppId }
              : {}),
            ...(props.connectorSecrets.githubPrivateKey
              ? { GITHUB_PRIVATE_KEY: props.connectorSecrets.githubPrivateKey }
              : {}),
            ...(props.connectorSecrets.githubWebhookSecret
              ? { GITHUB_WEBHOOK_SECRET: props.connectorSecrets.githubWebhookSecret }
              : {}),
            ...(props.connectorSecrets.githubClientId
              ? { GITHUB_CLIENT_ID: props.connectorSecrets.githubClientId }
              : {}),
            ...(props.connectorSecrets.githubClientSecret
              ? { GITHUB_CLIENT_SECRET: props.connectorSecrets.githubClientSecret }
              : {}),
            ...(props.connectorSecrets.atlassianClientId
              ? { ATLASSIAN_CLIENT_ID: props.connectorSecrets.atlassianClientId }
              : {}),
            ...(props.connectorSecrets.atlassianClientSecret
              ? {
                  ATLASSIAN_CLIENT_SECRET: props.connectorSecrets.atlassianClientSecret,
                }
              : {}),
          },
        })
      : undefined;

    const connectorEnv: Record<string, ecs.Secret> = {};
    if (connectorSecret) {
      if (props.connectorSecrets?.githubAppId) {
        connectorEnv.GITHUB_APP_ID = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "GITHUB_APP_ID",
        );
      }
      if (props.connectorSecrets?.githubPrivateKey) {
        connectorEnv.GITHUB_PRIVATE_KEY = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "GITHUB_PRIVATE_KEY",
        );
      }
      if (props.connectorSecrets?.githubWebhookSecret) {
        connectorEnv.GITHUB_WEBHOOK_SECRET = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "GITHUB_WEBHOOK_SECRET",
        );
      }
      if (props.connectorSecrets?.githubClientId) {
        connectorEnv.GITHUB_CLIENT_ID = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "GITHUB_CLIENT_ID",
        );
      }
      if (props.connectorSecrets?.githubClientSecret) {
        connectorEnv.GITHUB_CLIENT_SECRET = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "GITHUB_CLIENT_SECRET",
        );
      }
      if (props.connectorSecrets?.atlassianClientId) {
        connectorEnv.ATLASSIAN_CLIENT_ID = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "ATLASSIAN_CLIENT_ID",
        );
      }
      if (props.connectorSecrets?.atlassianClientSecret) {
        connectorEnv.ATLASSIAN_CLIENT_SECRET = ecs.Secret.fromSecretsManager(
          connectorSecret,
          "ATLASSIAN_CLIENT_SECRET",
        );
      }
    }

    this.resources = {
      authSecret,
      databaseUrlSecret,
      modelProviderSecret,
      smtpSecret,
      connectorSecret,
      connectorEnv,
    };
  }
}
