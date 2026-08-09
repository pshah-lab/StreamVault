#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────────────────────
# deploy-web.sh — Build, upload, and invalidate the Pratham Cinema viewer.
#
# Usage:
#   ./scripts/deploy-web.sh [bucket]
#
# Examples:
#   ./scripts/deploy-web.sh                       # uses default bucket
#   ./scripts/deploy-web.sh my-other-bucket        # override the bucket
#
# Environment overrides:
#   AWS_PROFILE           AWS credential profile (default: reactUser)
#   BUCKET                S3 bucket name         (default: ***REMOVED***)
#   DISTRIBUTION_ID       CloudFront dist ID     (read from stack-outputs.json)
#   SKIP_BUILD            set to 1 to skip the build step
#   SKIP_INVALIDATION     set to 1 to skip CloudFront invalidation
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Resolve project root (one level up from scripts/) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Configuration ──
export AWS_PROFILE="${AWS_PROFILE:-reactUser}"
BUCKET="${1:-${BUCKET:-***REMOVED***}}"
DIST_DIR="web/dist"

# Read CloudFront distribution ID from stack-outputs.json if not overridden
if [[ -z "${DISTRIBUTION_ID:-}" ]]; then
  if [[ -f stack-outputs.json ]]; then
    DISTRIBUTION_ID="$(node -e "console.log(require('./stack-outputs.json').ExistingDistributionId)")"
  else
    echo "Error: stack-outputs.json not found and DISTRIBUTION_ID not set."
    exit 1
  fi
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              Pratham Cinema — Web Deployment                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Profile:       $AWS_PROFILE"
echo "  Bucket:        $BUCKET"
echo "  Distribution:  $DISTRIBUTION_ID"
echo ""

# ── Step 1: Build ──
if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "⏭  Skipping build (SKIP_BUILD=1)"
else
  echo "🔨 Building web app..."
  pnpm build:web
  echo "   ✅ Build complete"
fi
echo ""

# ── Verify build output exists ──
if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "Error: No built viewer found at $DIST_DIR/index.html."
  echo "       Run 'pnpm build:web' first, or remove SKIP_BUILD=1."
  exit 1
fi

# ── Step 2: Upload to S3 ──
echo "📤 Uploading to s3://$BUCKET/app/ ..."

# Hashed assets → immutable cache (1 year)
aws s3 sync "$DIST_DIR" "s3://$BUCKET/app" \
  --exclude "index.html" \
  --exclude "movies.json" \
  --cache-control "public, max-age=31536000, immutable"

# index.html → no cache (always fetch latest)
aws s3 cp "$DIST_DIR/index.html" "s3://$BUCKET/app/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache"

# movies.json → no cache (always check for latest catalog)
aws s3 cp "$DIST_DIR/movies.json" "s3://$BUCKET/app/movies.json" \
  --content-type "application/json" \
  --cache-control "no-cache"

echo "   ✅ Upload complete"
echo ""

# ── Step 3: CloudFront Invalidation ──
if [[ "${SKIP_INVALIDATION:-}" == "1" ]]; then
  echo "⏭  Skipping CloudFront invalidation (SKIP_INVALIDATION=1)"
else
  echo "🌐 Invalidating CloudFront cache for /app/* ..."
  INVALIDATION_OUTPUT="$(aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/app/*" \
    --output json)"

  INVALIDATION_ID="$(echo "$INVALIDATION_OUTPUT" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).Invalidation.Id))
  ")"
  echo "   Invalidation ID: $INVALIDATION_ID"

  echo "   ⏳ Waiting for invalidation to complete..."
  aws cloudfront wait invalidation-completed \
    --distribution-id "$DISTRIBUTION_ID" \
    --id "$INVALIDATION_ID"

  echo "   ✅ Invalidation complete"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  🎬 Deployed! View at:"
echo "  https://***REMOVED***.cloudfront.net/app/index.html"
echo "═══════════════════════════════════════════════════════════════"
echo ""
