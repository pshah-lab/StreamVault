#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { VideoAuthStack } from "../lib/video-auth-stack.js";

const app = new cdk.App();
new VideoAuthStack(app, "VideoAuthStack", {
  // The existing CloudFront distribution ***REMOVED*** belongs to this account.
  // Pinning it prevents an auth stack from being deployed to an unrelated AWS profile.
  env: { account: "***REMOVED***", region: "ap-south-1" },
  description: "Cognito authentication and signed-cookie controls for the HLS viewer.",
});
