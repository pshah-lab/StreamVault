import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class VideoAuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const viewerDomain = new cdk.CfnParameter(this, "ViewerDomain", {
      type: "String",
      default: "***REMOVED***.cloudfront.net",
      description: "Existing CloudFront distribution domain used for callbacks and signed-cookie scope.",
    });
    const cognitoDomainPrefix = new cdk.CfnParameter(this, "CognitoDomainPrefix", {
      type: "String",
      description: "Globally unique Cognito Hosted UI domain prefix, for example pratham-hls-viewer-***REMOVED***.",
    });
    const cloudFrontPublicKeyPem = new cdk.CfnParameter(this, "CloudFrontPublicKeyPem", {
      type: "String",
      description: "PEM public key paired with the private key stored in Secrets Manager.",
    });

    const userPool = new cognito.UserPool(this, "ViewerUserPool", {
      userPoolName: "pratham-hls-viewers",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("HostedUiClient", {
      userPoolClientName: "pratham-hls-hosted-ui",
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [cdk.Fn.join("", ["https://", viewerDomain.valueAsString, "/auth/callback"])],
        logoutUrls: [cdk.Fn.join("", ["https://", viewerDomain.valueAsString, "/app/index.html"])],
      },
      preventUserExistenceErrors: true,
    });

    const hostedUiDomain = new cognito.CfnUserPoolDomain(this, "HostedUiDomain", {
      domain: cognitoDomainPrefix.valueAsString,
      userPoolId: userPool.userPoolId,
    });

    const signingKeySecret = new secretsmanager.CfnSecret(this, "CloudFrontSigningPrivateKey", {
      name: "hls-video-viewer/cloudfront-signing-key",
      description: "Replace privateKey before enabling the CloudFront trusted key group.",
      secretString: JSON.stringify({ privateKey: "REPLACE_BEFORE_FIRST_LOGIN" }),
    });
    const stateSecret = new secretsmanager.Secret(this, "AuthStateSecret", {
      secretName: "hls-video-viewer/auth-state",
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "stateSecret", excludePunctuation: true },
    });

    const publicKey = new cloudfront.CfnPublicKey(this, "ViewerSigningPublicKey", {
      publicKeyConfig: {
        callerReference: `${this.stackName}-viewer-signing-key`,
        name: "pratham-hls-viewer-signing-key",
        encodedKey: cloudFrontPublicKeyPem.valueAsString,
      },
    });
    const keyGroup = new cloudfront.CfnKeyGroup(this, "ViewerSigningKeyGroup", {
      keyGroupConfig: {
        name: "pratham-hls-viewers",
        items: [publicKey.ref],
      },
    });

    const authHandler = new lambdaNodejs.NodejsFunction(this, "AuthHandler", {
      entry: path.join(import.meta.dirname, "../../services/auth/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        VIEWER_DOMAIN: viewerDomain.valueAsString,
        COGNITO_DOMAIN: cdk.Fn.join("", [cognitoDomainPrefix.valueAsString, ".auth.", this.region, ".amazoncognito.com"]),
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        CLOUDFRONT_KEY_PAIR_ID: publicKey.ref,
        SIGNING_KEY_SECRET_ARN: signingKeySecret.ref,
        STATE_SECRET_ARN: stateSecret.secretArn,
      },
      bundling: { minify: true, sourceMap: true },
    });
    authHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [signingKeySecret.ref, stateSecret.secretArn],
    }));

    const ec2WorkerVpc = new ec2.Vpc(this, "Ec2ChunkWorkerVpc", {
      vpcName: "hls-video-chunker-ec2-vpc",
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });
    const ec2WorkerSecurityGroup = new ec2.SecurityGroup(this, "Ec2ChunkWorkerSecurityGroup", {
      vpc: ec2WorkerVpc,
      securityGroupName: "hls-video-chunker-ec2-worker",
      description: "No inbound access; outbound only for one-shot HLS EC2 workers.",
      allowAllOutbound: true,
    });

    const ec2WorkerRole = new iam.Role(this, "Ec2ChunkWorkerRole", {
      roleName: "hls-video-chunker-ec2-worker",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "One-shot on-demand EC2 worker role for converting source videos to HLS and uploading to S3.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: ["arn:aws:s3:::***REMOVED***/input/*"],
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: ["arn:aws:s3:::***REMOVED***"],
      conditions: {
        StringLike: {
          "s3:prefix": ["output*"],
        },
      },
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:DeleteObject"],
      resources: ["arn:aws:s3:::***REMOVED***/output*/*"],
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudfront:CreateInvalidation"],
      resources: ["arn:aws:cloudfront::***REMOVED***:distribution/***REMOVED***"],
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ec2:TerminateInstances"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "ec2:ResourceTag/HlsEc2Worker": "true",
        },
      },
    }));

    new iam.CfnInstanceProfile(this, "Ec2ChunkWorkerInstanceProfile", {
      instanceProfileName: "hls-video-chunker-ec2-worker",
      roles: [ec2WorkerRole.roleName],
    });

    const authApi = new apigwv2.HttpApi(this, "AuthApi", {
      apiName: "pratham-hls-auth",
      createDefaultStage: true,
    });
    authApi.addRoutes({ path: "/auth/{proxy+}", methods: [apigwv2.HttpMethod.GET], integration: new apigwv2Integrations.HttpLambdaIntegration("AuthIntegration", authHandler) });

    const playbackTable = new dynamodb.Table(this, "PlaybackProgressTable", {
      tableName: "PrathamCinemaPlayback",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "movie_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    playbackTable.addGlobalSecondaryIndex({
      indexName: "UserUpdatedAtIndex",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updated_at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new cdk.CfnOutput(this, "AuthApiDomain", { value: cdk.Fn.select(2, cdk.Fn.split("/", authApi.apiEndpoint)) });
    new cdk.CfnOutput(this, "CloudFrontKeyGroupId", { value: keyGroup.ref });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedUiDomainOutput", { value: cdk.Fn.join("", [cognitoDomainPrefix.valueAsString, ".auth.", this.region, ".amazoncognito.com"]) });
    new cdk.CfnOutput(this, "SigningKeySecretArn", { value: signingKeySecret.ref });
    new cdk.CfnOutput(this, "PlaybackTableName", { value: playbackTable.tableName });
    new cdk.CfnOutput(this, "Ec2WorkerInstanceProfileName", { value: "hls-video-chunker-ec2-worker" });
    new cdk.CfnOutput(this, "Ec2WorkerSubnetId", { value: ec2WorkerVpc.publicSubnets[0].subnetId });
    new cdk.CfnOutput(this, "Ec2WorkerSecurityGroupId", { value: ec2WorkerSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "ExistingDistributionIdOutput", { value: "***REMOVED***" });

  }
}
