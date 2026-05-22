import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import type { OutputsConstructProps } from "./contracts";

export class OutputsConstruct extends Construct {
  public constructor(scope: Construct, id: string, props: OutputsConstructProps) {
    super(scope, id);

    new cdk.CfnOutput(this, "AppUrl", {
      value: props.appUrl,
    });
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: props.albDnsName,
    });
    new cdk.CfnOutput(this, "DatabaseUrlSecretArn", {
      value: props.databaseUrlSecretArn,
    });
    new cdk.CfnOutput(this, "ModelProviderSecretArn", {
      value: props.modelProviderSecretArn,
    });
    new cdk.CfnOutput(this, "SmtpSecretArn", {
      value: props.smtpSecretArn,
    });

    if (props.connectorSecretArn) {
      new cdk.CfnOutput(this, "ConnectorSecretArn", {
        value: props.connectorSecretArn,
      });
    }
  }
}
