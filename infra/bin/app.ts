#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { VideoAuthStack } from "../lib/video-auth-stack.js";

const app = new cdk.App();
new VideoAuthStack(app, "VideoAuthStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
  description: "Cognito authentication and signed-cookie controls for the HLS viewer.",
});
