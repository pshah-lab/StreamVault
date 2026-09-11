#!/usr/bin/env bash

# Publish the built viewer without touching the protected HLS output prefix.
# Usage: ./scripts/upload-app.sh my-bucket

set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

BUCKET="${1:-}"
DIST_DIR="${DIST_DIR:-web/dist}"

if [[ -z "$BUCKET" ]]; then
  echo "Usage: $0 <bucket-name>"
  exit 1
fi

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "No built viewer found at $DIST_DIR. Run 'pnpm build:web' first."
  exit 1
fi

aws s3 sync "$DIST_DIR" "s3://$BUCKET/app" \
  --exclude "index.html" \
  --exclude "login.html" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp "$DIST_DIR/index.html" "s3://$BUCKET/app/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache"
if [[ -f "$DIST_DIR/login.html" ]]; then
  aws s3 cp "$DIST_DIR/login.html" "s3://$BUCKET/app/login.html" \
    --content-type "text/html; charset=utf-8" \
    --cache-control "no-cache"
fi

echo "Viewer uploaded to s3://$BUCKET/app/"
