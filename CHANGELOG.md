# StreamVault — Ultimate Project Changelog

A comprehensive, chronological, and architectural record of all modifications, security hardening, feature releases, and infrastructure migrations from project initialization to the present.

---

## Release & Milestone Roadmap

```
v0.1.0 (Aug 9, 2026)      Initial Pipeline, FFmpeg chunking & EC2 one-shot workers
        │
v1.0.0 (Aug 10, 2026)     AWS CDK VideoAuthStack, Cognito User Pools & CloudFront Signed Cookies
        │
v1.1.0 (Aug 11-12, 2026)  Enterprise Glassmorphic UI, Multi-Audio/Subtitles, Mobile/Safari Engine
        │
v1.2.0 (Aug 22, 2026)     Docker non-root execution, XSS Sanitization & Security Headers
        │
v1.3.0 (Sep 9, 2026)      Codex Audit Remediation (CWE-78, 400, 732, 16), Cognito RS256 & Zero Hardcoded IDs
```

---

## [v1.3.0] — 2026-09-09: Enterprise Security Hardening & Zero-Hardcoding Cloud Architecture

### Highlights
- **Codex Security Audit Remediation**: 100% resolution of all 4 vulnerabilities (1 High, 3 Medium) identified in `codex-security-report.md` and `codex-security-results.sarif`.
- **Cognito RS256 Asymmetric Authentication**: Migrated FastAPI backend from symmetric HMAC secrets (`JWT_SECRET`, HS256) to native Amazon Cognito JWKS asymmetric signature verification.
- **Zero Hardcoded Infrastructure IDs**: Sourced all networking (`VPC_ID`, `Public_Subnet_ID`, `Security_Group_ID`), storage, and database configurations directly from environment variables.
- **VPC Quota & Teardown Stabilization**: Avoided AWS Internet Gateway limits by importing existing VPC resources, eliminated deployment-blocking custom resources, and prevented orphaned Cognito pools.

---

### Detailed Changes by Component

#### 1. Security & Vulnerability Remediations
* **CWE-78: Shell Injection in EC2 User-Data (High)**
  - *File*: [`scripts/launch-ec2-chunk-job.sh`](file:///Users/pshah/Documents/hls-video-chunker/scripts/launch-ec2-chunk-job.sh)
  - *Fix*: Implemented strict regex gate (`^[a-zA-Z0-9._/-]+$`) on `INPUT_KEY` and `OUTPUT_PREFIX` prior to heredoc interpolation. Any key containing shell metacharacters (`` ` ``, `$()`, `;`, `|`, `&`) is immediately halted.
  - *Logging*: Added an automated trap in `finish()` that uploads `/var/log/hls-ec2-worker.log` to `s3://$BUCKET/$OUTPUT_PREFIX/$HLS_NAME/logs/` upon worker success or failure before instance self-termination.
* **CWE-400: Resource Exhaustion & Unbounded Inputs (Medium)**
  - *File*: [`backend/main.py`](file:///Users/pshah/Documents/hls-video-chunker/backend/main.py)
  - *Fix*: Added Pydantic `@field_validator("seconds")` clamping playback position to `[0.0, 86400.0]` (24h maximum) and rejecting non-finite values (`NaN`, `Infinity`, negative numbers).
  - *ID Limits*: Enforced `max_length=128` and regex character validation on `movie_id`.
  - *Pagination*: Upgraded `/api/history` from unbounded query to cursor-based pagination with `limit` (default 50, max 100) and base64-encoded `next_token` backed by DynamoDB `LastEvaluatedKey`.
  - *Resilience*: Enhanced logging via `logger.exception` and standard HTTP 503 responses on database errors.
* **CWE-732: Cross-Title Output Overwrite / Deletion (Medium)**
  - *File*: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts)
  - *Fix*: Removed `s3:DeleteObject` from `Ec2ChunkWorkerRole`. Workers are strictly constrained to `s3:PutObject` on `output*/*` and `s3:GetObject` on `input/*`.
* **CWE-16: Unenforced S3 Media Privacy (Medium)**
  - *File*: [`infra/bucket-tls-policy.json`](file:///Users/pshah/Documents/hls-video-chunker/infra/bucket-tls-policy.json), [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts)
  - *Fix*: Created standalone TLS-only bucket policy denying non-TLS (`aws:SecureTransport: false`) connections, accompanied by comprehensive operator documentation for Block Public Access, SSE-S3/KMS, and OAC.

#### 2. Authentication & Cryptography Overhaul
* *File*: [`backend/main.py`](file:///Users/pshah/Documents/hls-video-chunker/backend/main.py), [`backend/requirements.txt`](file:///Users/pshah/Documents/hls-video-chunker/backend/requirements.txt)
* Replaced legacy HS256 HMAC shared-secret JWT verification with **Cognito RS256 JWKS verification**.
* Automatically fetches and caches public keys from `https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json`.
* Validates token headers, key IDs (`kid`), token expiry (`exp`), subject (`sub`), issuer, and audience matching `COGNITO_CLIENT_ID`.
* Enforces `token_use == "id"` and incorporates automatic cache-bust retry logic for seamless key rotation.

#### 3. AWS CDK & Infrastructure Refactoring
* *Files*: [`infra/lib/video-auth-stack.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/lib/video-auth-stack.ts), [`infra/bin/app.ts`](file:///Users/pshah/Documents/hls-video-chunker/infra/bin/app.ts)
* Integrated native `process.loadEnvFile()` in `app.ts` to source `.env` automatically during synthesis and deployment.
* Replaced VPC and Security Group resource creation with dynamic imports (`VPC_ID`, `Public_Subnet_ID`, `Security_Group_ID`) to prevent hitting account Internet Gateway quotas.
* Imported existing DynamoDB table `PrathamCinemaPlayback` (`Table.fromTableAttributes`) using `DYNAMODB_TABLE_NAME` from environment.
* Removed problematic `ValidateSigningKey` custom resource that caused deployment rollbacks on initial secret creation.
* Configured `ViewerUserPool` removal policy to `DESTROY` to prevent orphaned Cognito pools during development.
* Fixed shell syntax issue by quoting multi-line PEM public keys in `.env`.

---

## [v1.2.0] — 2026-08-22: Container Security & Web App Hardening

### Highlights
- Implementation of defense-in-depth container security, HTTP security response headers, and DOM-based XSS sanitization.

### Changes
* **FastAPI Backend Security**:
  - Enforced non-root execution inside backend container (`USER 10001:10001`).
  - Added secure HTTP headers middleware: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and `Referrer-Policy: strict-origin-when-cross-origin`.
  - Added input regex sanitization for `movie_id` parameters.
* **Frontend XSS Defenses**:
  - Implemented client-side text escaping and sanitization for movie titles, descriptions, and metadata rendering.
* **Documentation**:
  - Sanitized and quoted Mermaid architectural diagram edge labels in [`README.md`](file:///Users/pshah/Documents/hls-video-chunker/README.md).

---

## [v1.1.0] — 2026-08-11 to 2026-08-12: Enterprise Cinema Interface & Cross-Platform Streaming Engine

### Highlights
- Transformation of StreamVault into a commercial-grade streaming experience with hero spotlights, genre filters, and native audio/subtitle support for iOS Safari and Android.

### Changes
* **User Interface & Styling**:
  - *Dark Glassmorphism Design*: Built a sleek, ambient-lit interface with frosted glass containers, smooth gradients, and backdrop blur filters.
  - *Hero Spotlight*: Added responsive featured movie banner with live preview playback and metadata badges.
  - *Genre & Category Chips*: Interactive filtering for Action, Drama, Fantasy, Sci-Fi, and Mythology.
  - *Key-Art Cards*: Replaced cropped posters with high-resolution 16:10 landscape cards and ambient background lighting.
  - *Continue Watching Rail*: Horizontal scrolling rail with persistent playback progress bars and custom scrollbars.
  - *Keyboard Navigation*: Added desktop controls (Space to Play/Pause, Left/Right arrows to seek $\pm5$s, Up/Down for volume, F for Fullscreen, M for Mute).
* **HLS Playback & Media Engine**:
  - *Multi-Track Audio*: Added HLS master playlist audio rendition switching, allowing viewers to choose between multiple language dubs (Hindi, Telugu, Tamil, English).
  - *Safari & Mobile iOS*: Implemented native HTML5 track pickers using `video.audioTracks` and `video.textTracks` alongside HLS.js for full cross-browser compatibility.
  - *Error Resilience*: Fixed video overlay bugs—listening to `AUDIO_TRACKS_UPDATED` and `SUBTITLE_TRACKS_UPDATED`, and automatically suppressing stale error overlays during active playback.
  - *CSS Display Enforcements*: Resolved CSS specificity issues overriding `hidden` attributes using `[hidden] { display: none !important; }`.
* **Authentication UI**:
  - Built dedicated enterprise sign-in landing page at [`/app/login.html`](file:///Users/pshah/Documents/hls-video-chunker/web/dist/login.html).
  - Configured Cognito User Pool Allowed Logout URLs to route to `/app/login.html`.

---

## [v1.0.0] — 2026-08-10 to 2026-08-11: AWS CDK Cloud Architecture & Signed-Cookie Security

### Highlights
- Production cloud deployment utilizing AWS CloudFront Signed Cookies, AWS Lambda, API Gateway, and Cognito User Pools.

### Changes
* **Cloud Infrastructure (`VideoAuthStack`)**:
  - Defined CloudFront Public Key and Key Group constructs for signed-cookie validation.
  - Configured AWS Secrets Manager for CloudFront private signing keys (`hls-video-viewer/cloudfront-signing-key`) and HMAC state generation (`hls-video-viewer/auth-state`).
  - Created Amazon Cognito User Pool with Hosted UI, custom domain prefixes, and PKCE authorization code grant flows.
  - Deployed Amazon API Gateway HTTP API integrated with Node.js 22 auth Lambda microservice (`services/auth/src/handler.ts`).
  - Set up DynamoDB `PrathamCinemaPlayback` table with Global Secondary Index `UserUpdatedAtIndex` for tracking user progress.
* **Authentication Microservice**:
  - Handles `/auth/login`, `/auth/callback`, `/auth/logout`, and `/auth/me`.
  - Exchanges OAuth authorization codes with Cognito, validates tokens, and issues three CloudFront Signed Cookies (`CloudFront-Policy`, `CloudFront-Signature`, `CloudFront-Key-Pair-Id`).
* **De-identification & Security Cleanup**:
  - Cleaned all hardcoded AWS accounts, bucket names, and personal identifiers across scripts and CDK definitions.
  - Stabilized logical resource identifiers to prevent state destruction across redeploys.

---

## [v0.1.0] — 2026-08-09: Foundation, FFmpeg Transcoder & EC2 One-Shot Pipeline

### Highlights
- Initialization of the StreamVault repository, local video chunking pipeline, and on-demand cloud transcoding infrastructure.

### Changes
* **Core Transcoding Engine**:
  - Implemented local HLS chunker using `ffmpeg-static` in `src/chunkVideo.js`.
  - Created multi-bitrate HLS encoding presets (1080p, 720p, 480p, 360p) with AAC audio encoding and segmented `.ts` playlists.
* **EC2 On-Demand Transcoder (`launch-ec2-chunk-job.sh`)**:
  - Scripted automated provisioning of one-shot `c7i.2xlarge` EC2 spot/on-demand instances.
  - Instance bootstraps via user-data, fetches raw video from `s3://$BUCKET/input/`, compiles HLS playlists with FFmpeg, uploads output to `s3://$BUCKET/output/`, invalidates CloudFront cache, and terminates itself to achieve zero idle cost.
* **End-to-End Orchestrator (`pipeline.sh`)**:
  - Automated full workflow: catalog parsing (`movies.json`), local/remote S3 verification, EC2 job launch, polling, and catalog synchronization.
* **Deployment Automation (`deploy-web.sh`, `upload-app.sh`)**:
  - S3 static sync scripts with optimal cache headers (1-year immutable caching for fingerprinted assets, `no-cache` for HTML/catalog).

---

## Complete Git Commit Ledger

| Hash | Date | Author | Commit Message |
|---|---|---|---|
| `9f43eae` | 2026-08-09 | pshah-lab | chore: initialize StreamVault workspace foundation and documentation |
| `a3ec783` | 2026-08-09 | pshah-lab | docs: sanitize README by removing emojis and regional AWS defaults |
| `268ad0e` | 2026-08-09 | pshah-lab | feat(pipeline): add HLS video processing scripts, EC2 chunker, and catalog definitions |
| `6db9d0f` | 2026-08-10 | pshah-lab | feat(auth): add AWS CDK VideoAuthStack and Cognito CloudFront auth microservice |
| `4d17397` | 2026-08-10 | pshah-lab | fix(infra): remove hardcoded AWS account number from app.ts |
| `5deb716` | 2026-08-10 | pshah-lab | fix(security): parameterize hardcoded AWS account IDs, bucket names, and distribution IDs |
| `813da4a` | 2026-08-10 | pshah-lab | fix(scripts): add smart local fallback for pipeline and web deploy |
| `22f9ef4` | 2026-08-10 | pshah-lab | feat(config): add .env loader support and .env.example template for local environment variables |
| `75ac89c` | 2026-08-11 | pshah-lab | feat(web): add glassmorphic web viewer, HLS.js player, and multi-track audio controls |
| `49f78f1` | 2026-08-11 | pshah-lab | fix(security): remove all hardcoded secrets, PII, piracy filenames, and personal identifiers |
| `c354e26` | 2026-08-11 | pshah-lab | fix(infra): revert CDK resource names to match deployed AWS resources — prevents data loss on redeploy |
| `b4a5284` | 2026-08-11 | pshah-lab | fix(pipeline): escape filenames with apostrophes in catalog update to prevent JS syntax errors |
| `9195e46` | 2026-08-11 | pshah-lab | fix(pipeline): skip EC2 launch/wait if HLS output already exists on S3 |
| `84595ac` | 2026-08-11 | pshah-lab | fix(pipeline): pass arguments via process.argv in Node and env vars in Python to handle special characters cleanly |
| `245de66` | 2026-08-11 | pshah-lab | fix(audio): enable master playlist for Friends episodes to stream separate audio rendition with full sound |
| `63d7845` | 2026-08-11 | pshah-lab | fix(deploy): skip cp when web/public/movies.json is already a symlink |
| `22c4a01` | 2026-08-11 | pshah-lab | feat(catalog): remove Friends episodes from streaming catalog |
| `0a8809c` | 2026-08-11 | pshah-lab | style(ui): update continue watching rail to horizontal flex layout with custom styled scrollbars |
| `438a85f` | 2026-08-11 | pshah-lab | style(ui): set poster background-size to contain for uncropped poster rendering |
| `e392e10` | 2026-08-11 | pshah-lab | feat(ui): convert movie posters to high-resolution 16:10 landscape key-art cards with ambient background blending |
| `94b02f7` | 2026-08-11 | pshah-lab | clean: remove temporary test image files |
| `259f848` | 2026-08-11 | pshah-lab | feat(ui): upgrade StreamVault frontend to enterprise-grade cinema platform with hero spotlight, category chips, keyboard shortcuts, and dark glassmorphism |
| `2012533` | 2026-08-11 | pshah-lab | style(ui): ensure poster artwork is bright and vibrant at all times without requiring hover |
| `7493164` | 2026-08-11 | pshah-lab | fix(player): hide error overlay on video play and playing events to prevent stale error panels during active playback |
| `e296151` | 2026-08-11 | pshah-lab | fix(player): prevent non-blocking background 403 or network errors from displaying error overlay while video is actively playing |
| `5ec1ad7` | 2026-08-11 | pshah-lab | fix(css): add [hidden] { display: none !important; } and set explicit inline display styles on error overlay to prevent CSS display:flex from overriding HTML hidden attribute |
| `2bcc5d4` | 2026-08-11 | pshah-lab | fix(player): listen to HLS AUDIO_TRACKS_UPDATED and SUBTITLE_TRACKS_UPDATED events to reliably populate and display audio/subtitle dropdown pickers |
| `bce6dd2` | 2026-08-11 | pshah-lab | feat(player): support native HTML5 video audio and subtitle track pickers for Safari/mobile playback |
| `c183354` | 2026-08-11 | pshah-lab | feat(auth): add dedicated enterprise Sign In landing page (/app/login.html) and update logout_uri redirect |
| `d551462` | 2026-08-11 | pshah-lab | feat(auth): add /app/login.html to Cognito allowed logout URLs in CDK stack |
| `bc5963e` | 2026-08-11 | pshah-lab | fix(css): adjust z-index stacking order so poster images are 100% visible continuously instead of hidden behind solid parent background |
| `e5d970e` | 2026-08-12 | pshah-lab | fix(security): parametrize hardcoded sensitive infrastructure values with environment variables |
| `235aa65` | 2026-08-12 | pshah-lab | chore(git): update .gitignore rules and commit backend Dockerfile and requirements |
| `580d8c9` | 2026-08-22 | pshah-lab | feat: implement comprehensive security enhancements including JWT validation, XSS sanitization, HTTP security headers, and non-root Docker execution. |
| `51ea787` | 2026-08-22 | pshah-lab | docs: wrap architecture diagram edge labels in quotes for improved Mermaid rendering |
| `8e98d3a` | 2026-09-09 | pshah-lab | feat: migrate to Cognito RS256 authentication, add input validation, and enhance EC2 logging security |
