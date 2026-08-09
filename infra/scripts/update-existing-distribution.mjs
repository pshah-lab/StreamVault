#!/usr/bin/env node
/**
 * Adds the declared auth/app behaviors to the existing distribution without
 * rebuilding it. Run only after the CDK stack has deployed and record its
 * outputs in a JSON file; the script fetches the current config and ETag first.
 */
import fs from "node:fs";
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";

const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error("Usage: node update-existing-distribution.mjs <stack-outputs.json>");
const values = JSON.parse(fs.readFileSync(configPath, "utf8"));
const required = (name) => {
  if (!values[name]) throw new Error(`Missing ${name} in ${configPath}`);
  return values[name];
};
const distributionId = values.ExistingDistributionId ?? "***REMOVED***";
const viewerDomain = values.ViewerDomain ?? "***REMOVED***.cloudfront.net";
const client = new CloudFrontClient({});
const current = await client.send(new GetDistributionConfigCommand({ Id: distributionId }));
const config = current.DistributionConfig;
if (!config || !current.ETag) throw new Error("Could not read distribution configuration.");

const videoOriginId = values.ExistingVideoOriginId ?? "bahubali-output";
const videoOrigin = config.Origins?.Items?.find((origin) => origin.Id === videoOriginId);
if (!videoOrigin) throw new Error(`Video origin ${videoOriginId} was not found. No changes were made.`);
const origins = config.Origins?.Items ?? [];
for (const origin of origins) {
  origin.OriginPath ??= "";
  origin.CustomHeaders ??= { Quantity: 0 };
  if (origin.CustomOriginConfig) {
    origin.CustomOriginConfig.OriginReadTimeout ??= 30;
    origin.CustomOriginConfig.OriginKeepaliveTimeout ??= 5;
  }
}
const addOrigin = (origin) => { if (!origins.some((item) => item.Id === origin.Id)) origins.push(origin); };
addOrigin({ ...videoOrigin, Id: "viewer-app", OriginPath: "" });
addOrigin({ ...videoOrigin, Id: "protected-video-root", OriginPath: "" });
addOrigin({
  Id: "auth-api",
  DomainName: required("AuthApiDomain"),
  OriginPath: "",
  CustomHeaders: { Quantity: 0 },
  CustomOriginConfig: {
    HTTPPort: 80,
    HTTPSPort: 443,
    OriginProtocolPolicy: "https-only",
    OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
    OriginReadTimeout: 30,
    OriginKeepaliveTimeout: 5,
  },
});
config.Origins = { Quantity: origins.length, Items: origins };

const makeBehavior = (PathPattern, TargetOriginId, extras = {}) => ({
  PathPattern, TargetOriginId, ViewerProtocolPolicy: "redirect-to-https", Compress: true,
  SmoothStreaming: false,
  FieldLevelEncryptionId: "",
  LambdaFunctionAssociations: { Quantity: 0 },
  FunctionAssociations: { Quantity: 0 },
  GrpcConfig: { Enabled: false },
  AllowedMethods: { Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
  TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 },
  ...extras,
});
const behaviors = config.CacheBehaviors?.Items?.filter((item) => !["/app/*", "/auth/*", "/output/*"].includes(item.PathPattern)) ?? [];
const normalizeBehavior = (behavior) => {
  behavior.SmoothStreaming ??= false;
  behavior.FieldLevelEncryptionId ??= "";
  behavior.Compress ??= false;
  behavior.LambdaFunctionAssociations ??= { Quantity: 0 };
  behavior.FunctionAssociations ??= { Quantity: 0 };
  behavior.GrpcConfig ??= { Enabled: false };
};
normalizeBehavior(config.DefaultCacheBehavior);
for (const behavior of behaviors) normalizeBehavior(behavior);
behaviors.push(makeBehavior("/app/*", "viewer-app", { CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6" }));
// Free-plan distributions allow AWS-managed policies but block both custom
// policies and legacy cache settings. This managed pair forwards Cognito's
// callback query/cookies while omitting the viewer Host header for API Gateway.
behaviors.push(makeBehavior("/auth/*", "auth-api", {
  CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
}));
behaviors.push(makeBehavior("/output/*", "protected-video-root", {
  CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
  TrustedKeyGroups: { Enabled: true, Quantity: 1, Items: [required("CloudFrontKeyGroupId")] },
  TrustedSigners: { Enabled: false, Quantity: 0 },
}));
config.CacheBehaviors = { Quantity: behaviors.length, Items: behaviors };
config.DefaultCacheBehavior = { ...config.DefaultCacheBehavior, TrustedKeyGroups: { Enabled: true, Quantity: 1, Items: [required("CloudFrontKeyGroupId")] }, TrustedSigners: { Enabled: false, Quantity: 0 } };

await client.send(new UpdateDistributionCommand({ Id: distributionId, IfMatch: current.ETag, DistributionConfig: config }));
console.log(`Distribution ${distributionId} update started for ${viewerDomain}.`);
