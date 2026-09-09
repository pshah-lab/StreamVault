# Changelog: Last 24 Hours

**Generated:** September 9, 2026  
**Repository:** `pshah-lab/StreamVault`  
**Reference Commit:** [`8e98d3a`](https://github.com/pshah-lab/StreamVault/commit/8e98d3a) (`feat: migrate to Cognito RS256 authentication, add input validation, and enhance EC2 logging security`)

---

## Executive Summary

Over the past 24 hours, the StreamVault codebase underwent major security hardening, infrastructure refactoring, and authentication upgrades following an automated Codex security audit (`codex-security-report.md`, `codex-security-results.sarif`). In addition, hardcoded infrastructure IDs were eliminated in favor of dynamic environment variables, and the application was successfully deployed to AWS.

---

## 1. Security Vulnerability Fixes (Codex Audit)

### 1.1 Finding 1 (CWE-78): Command Injection in EC2 User-Data
* **File Modified**: [`scripts/launch-ec2-chunk-job.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/launch-ec2-chunk-job.sh)
* **Problem**: `INPUT_KEY` and `OUTPUT_PREFIX` were interpolated directly into a bash heredoc passed as EC2 user-data running as `root`. Crafted S3 keys containing shell metacharacters (`` ` ``, `$()`, `;`, `|`, `&`) could execute arbitrary commands with root privileges on the transcoding instance.
* **Changes Made**:
  - Added strict regex validation (`^[a-zA-Z0-9._/-]+$`) before user-data generation. Any key containing unexpected characters is immediately rejected with an exit code of 1.
  - Added an automated trap in `finish()` that uploads `/var/log/hls-ec2-worker.log` to S3 (`${OUTPUT_PREFIX}/${HLS_NAME}/logs/`) upon job success or failure before instance self-termination.
* **Why**: Prevents remote code execution (RCE) via untrusted S3 file names and provides persistent post-mortem debugging logs in S3.

---

### 1.2 Finding 2 (CWE-400): Resource Exhaustion & Unbounded Inputs
* **Files Modified**: [`backend/main.py`](file:///Users/pshah/Documents/hls-video-chunker/backend/main.py), [`backend/requirements.txt`](file:///Users/pshah/Documents/hls-video-chunker/backend/requirements.txt)
* **Problem**:
  1. The playback progress endpoint accepted unrestricted float values (e.g. `NaN`, `Infinity`, negative numbers, excessively large numbers).
  2. The `movie_id` identifier was unbounded in length.
  3. `/api/history` read and materialized all DynamoDB records for a user without limits or pagination.
* **Changes Made**:
  - Added a Pydantic `@field_validator("seconds")` clamping playback timestamps to `[0.0, 86400.0]` (24-hour limit) and rejecting non-finite numbers (`math.isfinite`).
  - Added `max_length=128` and regex character restrictions on `movie_id` across models and route path parameters.
  - Replaced the unbounded `/api/history` query with cursor-based pagination using a configurable `limit` parameter (default 50, maximum 100) and an opaque base64-encoded `next_token` backed by DynamoDB's `LastEvaluatedKey`.
  - Upgraded error handling to log stack traces with `logger.exception` and return standard HTTP 503 errors on database failures instead of silent defaults.
* **Why**: Prevents database Denial-of-Service (DoS), memory exhaustion, and invalid data corruption in DynamoDB.

---

### 1.3 Finding 3 (CWE-732): Excessive EC2 Worker IAM Permissions
* **File Modified**: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts)
* **Problem**: The IAM policy attached to `Ec2ChunkWorkerRole` granted `s3:DeleteObject` across `output*/*`. A compromised worker processing one movie could maliciously delete or overwrite output segments of other movies.
* **Changes Made**:
  - Removed `s3:DeleteObject` entirely from `Ec2ChunkWorkerRole`. Workers now only have `s3:PutObject` on `output*/*` and `s3:GetObject` on `input/*`.
* **Why**: Enforces the principle of least privilege—transcoding workers only need write/upload capability, never delete rights.

---

### 1.4 Finding 4 (CWE-16): Media S3 Bucket Hardening
* **Files Modified**: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts), [`infra/bucket-tls-policy.json`](file:///Users/pshah/Documents/hls-video-chunker/infra/bucket-tls-policy.json)
* **Problem**: The CDK stack references an existing S3 media bucket but cannot retroactively enforce Block Public Access, server-side encryption, or TLS policies through imported bucket constructs.
* **Changes Made**:
  - Created [`infra/bucket-tls-policy.json`](file:///Users/pshah/Documents/hls-video-chunker/infra/bucket-tls-policy.json) containing a standalone policy statement denying non-TLS (`aws:SecureTransport: false`) access.
  - Documented operator instructions and checklists in `video-auth-stack.ts` for configuring default SSE-S3/KMS, Object Ownership (`BucketOwnerEnforced`), and CloudFront Origin Access Control (OAC).
* **Why**: Protects media assets in transit and provides a clear operational guide for external bucket security.

---

## 2. Authentication Architecture Overhaul

* **File Modified**: [`backend/main.py`](file:///Users/pshah/Documents/hls-video-chunker/backend/main.py)
* **Problem**: The backend previously relied on a shared symmetric HMAC secret (`JWT_SECRET`, HS256), creating a credential management hazard and decoupling it from the Cognito User Pool used by CloudFront and the frontend.
* **Changes Made**:
  - Migrated authentication to **Cognito RS256 Asymmetric JWT Validation**.
  - Implemented automatic caching and fetching of the Cognito JSON Web Key Set (`/.well-known/jwks.json`).
  - Added token header inspection, key ID (`kid`) matching, issuer verification, and audience check against `COGNITO_CLIENT_ID`.
  - Added cache invalidation and retry logic to support zero-downtime key rotation.
  - Enforced `token_use == "id"` to guarantee only identity tokens are accepted.
* **Why**: Unifies authentication across the frontend, auth Lambda, and FastAPI backend using cryptographically signed tokens from Amazon Cognito without sharing private secrets.

---

## 3. Infrastructure Refactoring & Zero Hardcoded IDs

### 3.1 Dynamic VPC & Networking Configuration
* **Files Modified**: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts), [`infra/bin/app.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/bin/app.ts), [`scripts/launch-ec2-chunk-job.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/launch-ec2-chunk-job.sh), [`scripts/pipeline.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/pipeline.sh)
* **Problem**:
  - The stack was previously creating a new VPC and Internet Gateway, exceeding AWS account IGW quotas.
  - Subnet IDs, Security Group IDs, and VPC IDs were hardcoded in multiple files.
* **Changes Made**:
  - Updated [`infra/bin/app.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/bin/app.ts) to automatically load the root `.env` via Node.js native `process.loadEnvFile()`.
  - Refactored [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts) to dynamically read:
    - `VPC_ID` $\rightarrow$ `process.env.VPC_ID`
    - `Public_Subnet_ID` $\rightarrow$ `process.env.Public_Subnet_ID`
    - `Security_Group_ID` $\rightarrow$ `process.env.Security_Group_ID`
    - `DYNAMODB_TABLE_NAME` $\rightarrow$ `process.env.DYNAMODB_TABLE_NAME`
    - `S3_BUCKET_NAME` $\rightarrow$ `process.env.BUCKET`
    - `DISTRIBUTION_ID` $\rightarrow$ `process.env.DISTRIBUTION_ID`
  - Added `Ec2WorkerVpcId` to CloudFormation outputs.
  - Updated EC2 runner scripts ([`launch-ec2-chunk-job.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/launch-ec2-chunk-job.sh), [`pipeline.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/pipeline.sh)) to resolve networking IDs directly from `.env`.
* **Why**: Eliminates hardcoded infrastructure IDs, enables deployment into existing VPCs without hitting AWS quota limits, and allows seamless environment-based configuration.

---

### 3.2 Removal of Blocking Custom Resource & Clean Teardown
* **File Modified**: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts)
* **Problem**: A deploy-time custom resource (`ValidateSigningKey`) failed stack creation because it verified that the CloudFront signing key was not set to the placeholder `REPLACE_BEFORE_FIRST_LOGIN`—a value generated during the same initial deployment.
* **Changes Made**:
  - Removed `ValidateSigningKey` and its associated Lambda function.
  - Set `removalPolicy: cdk.RemovalPolicy.DESTROY` on `ViewerUserPool` so developmental rollbacks and teardowns do not leave orphaned Cognito UserPools in the account.
* **Why**: Unblocks CloudFormation deployment while allowing operators to populate secrets post-deployment.

---

## 4. Environment & Tooling Updates

* **[`.env.example`](file:///Users/pshah/Documents/hls-video-chunker/.env.example)**: Documented all required and optional environment variables:
  - `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_REGION`, `COGNITO_DOMAIN_PREFIX`
  - `CLOUDFRONT_PUBLIC_KEY_PEM` (quoted to prevent shell word splitting)
  - `VPC_ID`, `Public_Subnet_ID`, `Security_Group_ID`
  - `BUCKET`, `DISTRIBUTION_ID`, `VIEWER_DOMAIN`, `DYNAMODB_TABLE_NAME`
* **[`.env`](file:///Users/pshah/Documents/hls-video-chunker/.env)**: Quoted `CLOUDFRONT_PUBLIC_KEY_PEM` to fix bash shell sourcing errors (`PUBLIC: command not found`).
* **[`infra/package.json`](file:///Users/pshah/Documents/hls-video-chunker/infra/package.json)** & **[`pnpm-lock.yaml`](file:///Users/pshah/Documents/hls-video-chunker/pnpm-lock.yaml)**: Added `@aws-sdk/client-secrets-manager`.
* **[`.gitignore`](file:///Users/pshah/Documents/hls-video-chunker/.gitignore)**: Updated rules for `.DS_Store` and temporary bundling artifacts.

---

## 5. Deployment Verification

1. **AWS CDK Infrastructure**:
   - Stack `VideoAuthStack` deployed to AWS Region `ap-south-1` (`reactUser`, Account `914805778648`).
   - Final CloudFormation status: **`UPDATE_COMPLETE`**.
2. **Web Viewer Application**:
   - Production Vite bundle built with `tsc -b && vite build`.
   - Uploaded to `s3://pratham-shah-bucket/app/`.
   - CloudFront cache invalidation completed (`E9ZOY5M8AENFZ`).
   - Verified live at: **`https://d2u29nszfsuu8p.cloudfront.net/app/index.html`** (`HTTP/2 200 OK`).
