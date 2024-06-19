import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as aws_rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import {aws_route53_targets} from "aws-cdk-lib";

export class BookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: { env: { account: any, region: string, awsEnvironment: string }, }) {
    super(scope, id, props);

    const stackEnvironment: string | undefined = props?.env.awsEnvironment;

    let appUrl: string;
    let appFullUrl: string;

    if (stackEnvironment == "productionA") {
      appUrl = 'docs.wmaug.org'
      appFullUrl = `'https://${appUrl}`;
    }
    else {
      appUrl = `${stackEnvironment}-docs.wmaug.org`
      appFullUrl = `https://${appUrl}`;
    }

    cdk.Tags.of(this).add('Service', 'BookStack');
    if (stackEnvironment != null) {
      cdk.Tags.of(this).add('Environment', stackEnvironment);
    }

    const awsAccountNumber = ssm.StringParameter.valueFromLookup(this, '/all/awsAccountNumber');
    const domainHostedZoneId = ssm.StringParameter.valueFromLookup(this, '/all/aws/route53/wmaug.org/hostedZoneId');
    let SecretParamPath = `/${stackEnvironment}/BookStack/DB_PASS`;
    const SecretParam = {'DB_PASS': ssm.StringParameter.fromSecureStringParameterAttributes(this, 'DB_PASSParameter', {
        parameterName: SecretParamPath,
        version: 1,
      })};

    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      vpcName: `${stackEnvironment}Vpc`,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: id + '-Cluster',
    });

    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    fargateTaskDefinition.addContainer(`${id}Container`, {
      image: ecs.ContainerImage.fromRegistry("lscr.io/linuxserver/bookstack:latest"),
      portMappings: [{ containerPort: 6875 }],
    });

    fargateTaskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${awsAccountNumber}:*`],
    }));

    fargateTaskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${SecretParamPath}`],
    }));

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Allow inter-component traffic for BookStack ECS Service',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
        securityGroup,
        ec2.Port.allTraffic(),
        'Self referencing rule',
    );

    securityGroup.addIngressRule(
        ec2.Peer.ipv4('98.243.157.138/32'),
        ec2.Port.tcp(80),
        'Allow HTTP traffic',
    )

    securityGroup.addIngressRule(
        ec2.Peer.ipv4('98.243.157.138/32'),
        ec2.Port.tcp(443),
        'Allow HTTPS traffic',
    )

    const BookStackRds = new aws_rds.DatabaseInstance(this, 'BookStackRds', {
      engine: aws_rds.DatabaseInstanceEngine.mysql({ version: aws_rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [securityGroup],
      databaseName: `${id}Rds`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      allocatedStorage: 20,
      storageType: aws_rds.StorageType.GP2,
      backupRetention: cdk.Duration.days(1),
      multiAz: false,
      autoMinorVersionUpgrade: true,
    });

    // Export the RDS endpoints
    new cdk.CfnOutput(this, 'RDS Endpoint', { value: BookStackRds.dbInstanceEndpointAddress, });
    // apply endpoint as environment variable to task definition
    fargateTaskDefinition.defaultContainer?.addEnvironment('DB_HOST', BookStackRds.dbInstanceEndpointAddress);
    fargateTaskDefinition.defaultContainer?.addEnvironment('DB_PORT', '3306');
    fargateTaskDefinition.defaultContainer?.addEnvironment('TZ', 'Etc/UTC');
    fargateTaskDefinition.defaultContainer?.addEnvironment('DB_DATABASE', `${id}Rds`);
    fargateTaskDefinition.defaultContainer?.addEnvironment('APP_URL', appFullUrl);
    fargateTaskDefinition.defaultContainer?.addSecret('DB_PASS', ecs.Secret.fromSsmParameter(SecretParam['DB_PASS']));


    // Add an Elastic File System volume to the task definition
    const BookStackEfs = new efs.FileSystem(this, 'BookStackEfs', {
      vpc,
      allowAnonymousAccess: true,
      securityGroup,
      vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }),
    });

    const volume = {
      name: "volume",
      efsVolumeConfiguration: {
        fileSystemId: BookStackEfs.fileSystemId,
        transitEncryption: 'ENABLED',
      },
    };

    fargateTaskDefinition.addVolume(volume);

    const BookStackService = new ecs.FargateService(this,
        'BookStackService', {
          cluster,
          taskDefinition: fargateTaskDefinition,
          desiredCount: 1,
          assignPublicIp: false,
          vpcSubnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }),
          securityGroups: [securityGroup],
          enableExecuteCommand: true,
        });

    BookStackService.taskDefinition.defaultContainer?.addMountPoints({
      containerPath: "/config",
      sourceVolume: volume.name,
      readOnly: false,
    });

    BookStackService.node.addDependency(BookStackEfs);

    // Create ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true,
      securityGroup: securityGroup,
    });

    const httplistener = alb.addListener('httplistener', {
      port: 80,
      open: false,
    });

    // create alb certificate
    const albCert = new acm.Certificate(this, 'albCert', {
      domainName: appUrl,
      validation: acm.CertificateValidation.fromDns(),
    });

    // redirect httplistener to https
    const httpsListener = alb.addListener('httpsListener', {
      port: 443,
      certificates: [albCert],
      open: false,
    });

    httplistener.addAction('redirect', {
      action: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    httpsListener.addTargets('ECS', {
      port: 443,
      healthCheck: {
        path: "/",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
      },
      targets: [BookStackService]
    });

    // create new DNS record in Route53 pointing at the load balancer
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: domainHostedZoneId,
      zoneName: appUrl,
    });

    new route53.ARecord(this, 'ARecord', {
      zone: zone,
      target: route53.RecordTarget.fromAlias(new aws_route53_targets.LoadBalancerTarget(alb)),
      recordName: appUrl,
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: alb.loadBalancerDnsName, });
    new cdk.CfnOutput(this, 'ecsClusterId', { value: cluster.clusterName, });
  }
}
