# StreamVault

An end-to-end, enterprise streaming platform for chunking, securing, and streaming high-definition video over HTTP Live Streaming (HLS). Powered by **AWS CloudFront Signed Cookies**, **AWS Cognito**, **AWS Lambda**, **FFmpeg**, and a **Glassmorphic Web UI**.

---

## Key Features

- **Token-Gated HLS Streaming**: Full security for `.m3u8` playlists and `.ts` media segments using CloudFront Signed Cookies (`SameSite=Lax`).
- **Automated On-Demand EC2 Pipeline**: Parallel FFmpeg encoding workers launched on EC2 (`c7i.2xlarge`) for fast video chunking.
- **Multi-Audio & Subtitle Support**: Dynamic audio track switching (Hindi, English, Telugu, Tamil, Malayalam, Kannada) and WebVTT subtitle selection inside `Hls.js`.
- **Netflix-Style Glassmorphic UI**: 16:10 poster aspect ratio, vignette overlays, real-time debounced search, and responsive layout.
- **Continue Watching Progress**: Persistent watch state synchronized across client `LocalStorage` and AWS DynamoDB.

---

## System Architecture

```mermaid
flowchart TD

subgraph group_viewer["Viewer Experience"]
  node_web_ui["Web Viewer<br/>[main.ts]"]
  node_catalog["Movie Catalog<br/>[movies.json]"]
  node_hls_player["HLS.js Player<br/>[main.ts]"]
end

subgraph group_access["Access Control"]
  node_auth_lambda["Auth Handler<br/>[handler.ts]"]
  node_pkce_crypto["PKCE Security<br/>[crypto.ts]"]
end

subgraph group_delivery["Media Delivery"]
  node_cloudfront["CloudFront Distribution"]
  node_video_store[("Private S3 Assets")]
end

subgraph group_progress["Playback State"]
  node_progress_api["Progress API<br/>[main.py]"]
  node_jwt_auth["JWT Validation<br/>[main.py]"]
  node_progress_db[("Playback DynamoDB")]
end

subgraph group_pipeline["Media Pipeline"]
  node_pipeline["Pipeline Orchestrator<br/>[pipeline.sh]"]
  node_ec2_worker["EC2 Encode Worker"]
  node_hls_encoder["FFmpeg HLS Encoder<br/>[chunkVideo.js]"]
end

node_viewer_actor(("Viewer"))
node_operator_actor(("Operator"))
node_cognito["Cognito Hosted UI"]
node_secrets[("Secrets Manager")]

node_viewer_actor -->|"opens viewer"| node_web_ui
node_web_ui -->|"loads catalog"| node_catalog
node_web_ui -->|"starts sign-in"| node_cognito
node_cognito -->|"returns code"| node_auth_lambda
node_auth_lambda -->|"verifies state"| node_pkce_crypto
node_auth_lambda -->|"exchanges code"| node_cognito
node_auth_lambda -->|"reads secrets"| node_secrets
node_auth_lambda -->|"sets cookies"| node_web_ui
node_web_ui -->|"requests HLS"| node_cloudfront
node_cloudfront -->|"serves assets"| node_video_store
node_web_ui -->|"starts playback"| node_hls_player
node_hls_player -->|"loads playlists"| node_cloudfront
node_web_ui -->|"syncs progress"| node_progress_api
node_progress_api -->|"validates identity"| node_jwt_auth
node_progress_api -->|"reads and writes"| node_progress_db
node_operator_actor -->|"runs pipeline"| node_pipeline
node_pipeline -->|"launches worker"| node_ec2_worker
node_ec2_worker -->|"runs encoding"| node_hls_encoder
node_hls_encoder -->|"uploads HLS"| node_video_store
node_pipeline -->|"updates catalog"| node_catalog

click node_web_ui "https://github.com/pshah-lab/streamvault/blob/main/web/src/main.ts"
click node_catalog "https://github.com/pshah-lab/streamvault/blob/main/movies.json"
click node_auth_lambda "https://github.com/pshah-lab/streamvault/blob/main/services/auth/src/handler.ts"
click node_pkce_crypto "https://github.com/pshah-lab/streamvault/blob/main/services/auth/src/crypto.ts"
click node_hls_player "https://github.com/pshah-lab/streamvault/blob/main/web/src/main.ts"
click node_progress_api "https://github.com/pshah-lab/streamvault/blob/main/backend/main.py"
click node_jwt_auth "https://github.com/pshah-lab/streamvault/blob/main/backend/main.py"
click node_pipeline "https://github.com/pshah-lab/streamvault/blob/main/scripts/pipeline.sh"
click node_ec2_worker "https://github.com/pshah-lab/streamvault/blob/main/scripts/launch-ec2-chunk-job.sh"
click node_hls_encoder "https://github.com/pshah-lab/streamvault/blob/main/src/chunkVideo.js"

classDef toneNeutral fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
classDef toneIndigo fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81
classDef toneTeal fill:#ccfbf1,stroke:#0f766e,stroke-width:1.5px,color:#134e4a
class node_web_ui,node_catalog,node_hls_player,node_viewer_actor,node_cognito toneBlue
class node_auth_lambda,node_pkce_crypto,node_secrets toneAmber
class node_cloudfront,node_video_store toneMint
class node_progress_api,node_jwt_auth,node_progress_db toneRose
class node_pipeline,node_ec2_worker,node_hls_encoder,node_operator_actor toneIndigo
```

---

## Quick Start & Local Development

### Prerequisites

- **Node.js** v20+ and **pnpm**
- **AWS CLI** configured with appropriate permissions
- **FFmpeg** installed locally (for local chunking tests)

### Installation

```bash
# Clone the repository
git clone https://github.com/pshah-lab/StreamVault.git
cd StreamVault

# Install dependencies across workspace
pnpm install
```

### Local Build Checks

```bash
pnpm build:web
pnpm build:infra
```

---

## Deployment & Pipeline Usage

### 1. Deploy Infrastructure (AWS CDK)

```bash
# Generate local signing key pair
bash infra/scripts/create-cloudfront-key-pair.sh

# Deploy CDK Stack
pnpm --dir infra cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_AWS_REGION
pnpm --dir infra cdk deploy \
  --parameters CognitoDomainPrefix=YOUR_COGNITO_DOMAIN_PREFIX \
  --parameters CloudFrontPublicKeyPem="$(cat .secrets/cloudfront/public.pem)"
```

### 2. Deploy Web Viewer

```bash
pnpm deploy:web
```

This command automatically builds the web app (`web/dist`), syncs assets to `s3://YOUR_BUCKET_NAME/app/`, and invalidates the CloudFront cache.

---

## Automated End-to-End Pipeline

Process raw `.mp4`, `.mkv`, or `.mov` files from raw input to live streaming in a single command:

```bash
# Drop video files into input/ directory
pnpm pipeline
```

| Step                          | Action                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| **1. Scan**             | Detects new video files in`input/`                         |
| **2. Metadata**         | Prompts for title, subtitle, year, and HLS name              |
| **3. Upload**           | Uploads raw source file to`s3://YOUR_BUCKET_NAME/input/`   |
| **4. EC2 Chunking**     | Launches an on-demand EC2 worker for FFmpeg transcoding      |
| **5. S3 Sync**          | Uploads multi-audio HLS playlists and segments to`output/` |
| **6. Catalog & Deploy** | Updates`movies.json` and deploys web viewer                |

---

## Inviting Viewers

Create invite-only viewer accounts using AWS Cognito:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_USER_POOL_ID \
  --username viewer@example.com \
  --user-attributes Name=email,Value=viewer@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
