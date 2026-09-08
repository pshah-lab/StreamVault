import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
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
      default: process.env.VIEWER_DOMAIN,
      description: "Existing CloudFront distribution domain used for callbacks and signed-cookie scope.",
    });
    const cognitoDomainPrefix = new cdk.CfnParameter(this, "CognitoDomainPrefix", {
      type: "String",
      default: process.env.COGNITO_DOMAIN_PREFIX,
      description: "Globally unique Cognito Hosted UI domain prefix.",
    });
    const cloudFrontPublicKeyPem = new cdk.CfnParameter(this, "CloudFrontPublicKeyPem", {
      type: "String",
      default: (process.env.CLOUDFRONT_PUBLIC_KEY_PEM || "").replace(/\\n/g, "\n"),
      description: "PEM public key paired with the private key stored in Secrets Manager.",
    });
    const s3BucketName = new cdk.CfnParameter(this, "S3BucketName", {
      type: "String",
      default: process.env.BUCKET || process.env.S3_BUCKET_NAME,
      description: "Name of the S3 bucket storing input raw videos and HLS output playlists.",
    });
    const existingDistributionId = new cdk.CfnParameter(this, "ExistingDistributionId", {
      type: "String",
      default: process.env.DISTRIBUTION_ID,
      description: "Existing CloudFront Distribution ID.",
    });

    // ── Media bucket security hardening (CWE-16) ──
    // CDK cannot retroactively set BlockPublicAccess, default encryption (SSE-S3/KMS),
    // ObjectOwnership, or OAC-only access on an imported bucket. Those settings MUST be
    // configured on the bucket itself (via console, CLI, or a dedicated hardening stack).
    //
    // Additionally, the CDK execution role does not have s3:PutBucketPolicy on the
    // existing bucket, so the TLS-only policy must be applied directly:
    //
    //   aws s3api put-bucket-policy --bucket <BUCKET_NAME> --policy file://bucket-tls-policy.json
    //
    // Operator checklist for the imported bucket:
    //   - Block Public Access: all four settings enabled
    //   - Default encryption: SSE-S3 or SSE-KMS with bucket key
    //   - Object Ownership: BucketOwnerEnforced (disables ACLs)
    //   - CloudFront OAC: only the distribution should have read access
    //   - Bucket policy: deny aws:SecureTransport=false (TLS-only)

    const userPool = new cognito.UserPool(this, "ViewerUserPool", {
      userPoolName: "pratham-hls-viewers",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("HostedUiClient", {
      userPoolClientName: "pratham-hls-hosted-ui",
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [cdk.Fn.join("", ["https://", viewerDomain.valueAsString, "/auth/callback"])],
        logoutUrls: [
          cdk.Fn.join("", ["https://", viewerDomain.valueAsString, "/app/login.html"]),
          cdk.Fn.join("", ["https://", viewerDomain.valueAsString, "/app/index.html"]),
        ],
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

    // Import existing VPC networking resources (configured via environment variables)
    const ec2WorkerVpcId = new cdk.CfnParameter(this, "Ec2WorkerVpcIdParam", {
      type: "String",
      default: process.env.VPC_ID || "",
      description: "VPC ID for the EC2 chunk worker.",
    });
    const ec2WorkerSubnetId = new cdk.CfnParameter(this, "Ec2WorkerSubnetIdParam", {
      type: "String",
      default: process.env.Public_Subnet_ID || process.env.PUBLIC_SUBNET_ID || "",
      description: "Public subnet ID for the EC2 chunk worker (must have internet access).",
    });
    const ec2WorkerSecurityGroupId = new cdk.CfnParameter(this, "Ec2WorkerSecurityGroupIdParam", {
      type: "String",
      default: process.env.Security_Group_ID || process.env.SECURITY_GROUP_ID || "",
      description: "Security group ID for the EC2 chunk worker (outbound-only, no inbound).",
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
      resources: [`arn:aws:s3:::${s3BucketName.valueAsString}/input/*`],
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::${s3BucketName.valueAsString}`],
      conditions: {
        StringLike: {
          "s3:prefix": ["output*"],
        },
      },
    }));
    // CWE-732: Workers only upload — DeleteObject removed to prevent
    // a compromised worker from deleting other titles' output.
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject"],
      resources: [`arn:aws:s3:::${s3BucketName.valueAsString}/output*/*`],
    }));
    ec2WorkerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudfront:CreateInvalidation"],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${existingDistributionId.valueAsString}`],
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

    // Import existing DynamoDB table (configured via environment variable or default)
    const playbackTable = dynamodb.Table.fromTableAttributes(this, "PlaybackProgressTable", {
      tableName: process.env.DYNAMODB_TABLE_NAME || "PrathamCinemaPlayback",
      globalIndexes: ["UserUpdatedAtIndex"],
    });

    new cdk.CfnOutput(this, "AuthApiDomain", { value: cdk.Fn.select(2, cdk.Fn.split("/", authApi.apiEndpoint)) });
    new cdk.CfnOutput(this, "CloudFrontKeyGroupId", { value: keyGroup.ref });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedUiDomainOutput", { value: cdk.Fn.join("", [cognitoDomainPrefix.valueAsString, ".auth.", this.region, ".amazoncognito.com"]) });
    new cdk.CfnOutput(this, "SigningKeySecretArn", { value: signingKeySecret.ref });
    new cdk.CfnOutput(this, "PlaybackTableName", { value: playbackTable.tableName });
    new cdk.CfnOutput(this, "Ec2WorkerInstanceProfileName", { value: "hls-video-chunker-ec2-worker" });
    new cdk.CfnOutput(this, "Ec2WorkerVpcId", { value: ec2WorkerVpcId.valueAsString });
    new cdk.CfnOutput(this, "Ec2WorkerSubnetId", { value: ec2WorkerSubnetId.valueAsString });
    new cdk.CfnOutput(this, "Ec2WorkerSecurityGroupId", { value: ec2WorkerSecurityGroupId.valueAsString });
    new cdk.CfnOutput(this, "ExistingDistributionIdOutput", { value: existingDistributionId.valueAsString });

  }
}
