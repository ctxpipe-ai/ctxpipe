import * as cdk from "aws-cdk-lib";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import type { IngressConstructProps, IngressResources } from "./contracts";

export class IngressConstruct extends Construct {
  public readonly resources: IngressResources;

  public constructor(scope: Construct, id: string, props: IngressConstructProps) {
    super(scope, id);

    if (props.customDomain) {
      const httpsListener = props.networking.alb.addListener("HttpsListener", {
        port: 443,
        open: true,
        certificates: [props.customDomain.certificate],
      });
      httpsListener.addTargets("BackendHttpsTarget", {
        targets: [
          props.backendService.loadBalancerTarget({
            containerName: "backend",
            containerPort: 3000,
          }),
        ],
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          path: "/health",
          healthyHttpCodes: "200-399",
        },
      });

      if (props.customDomain.redirectHttpToHttps ?? true) {
        props.networking.httpListener.addAction("HttpRedirect", {
          action: elbv2.ListenerAction.redirect({
            protocol: "HTTPS",
            port: "443",
            permanent: true,
          }),
        });
      } else {
        props.networking.httpListener.addTargets("BackendHttpTarget", {
          targets: [
            props.backendService.loadBalancerTarget({
              containerName: "backend",
              containerPort: 3000,
            }),
          ],
          port: 3000,
          protocol: elbv2.ApplicationProtocol.HTTP,
          healthCheck: {
            path: "/health",
            healthyHttpCodes: "200-399",
          },
        });
      }

      new route53.ARecord(this, "AlbAliasA", {
        zone: props.customDomain.hostedZone,
        recordName: props.customDomain.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(props.networking.alb),
        ),
      });
      new route53.AaaaRecord(this, "AlbAliasAaaa", {
        zone: props.customDomain.hostedZone,
        recordName: props.customDomain.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(props.networking.alb),
        ),
      });

      this.resources = {
        appUrl: `https://${props.customDomain.domainName}`,
      };
      return;
    }

    props.networking.httpListener.addTargets("BackendHttpTarget", {
      targets: [
        props.backendService.loadBalancerTarget({
          containerName: "backend",
          containerPort: 3000,
        }),
      ],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200-399",
      },
    });

    this.resources = {
      appUrl: cdk.Fn.join("", ["http://", props.networking.alb.loadBalancerDnsName]),
    };
  }
}
