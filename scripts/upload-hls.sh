#!/usr/bin/env bash

# Upload an HLS output directory while assigning the MIME types required by
# browsers and CDNs. Usage: ./scripts/upload-hls.sh my-video-bucket videos/lesson-1 [playlist-name]

set -euo pipefail

BUCKET="${1:-}"
PREFIX="${2:-}"
PLAYLIST_NAME="${3:-}"
OUTPUT_DIR="${OUTPUT_DIR:-output}"

if [[ -z "$BUCKET" ]]; then
  echo "Usage: $0 <bucket-name> [key-prefix] [playlist-name]"
  echo "Example: $0 my-video-bucket videos/bahubali-part-1 bahubali-part-1"
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required. Install it and run 'aws configure' first."
  exit 1
fi

if [[ -n "$PLAYLIST_NAME" ]]; then
  PLAYLIST_PATH="$OUTPUT_DIR/$PLAYLIST_NAME.m3u8"
else
  PLAYLIST_PATH="$OUTPUT_DIR/index.m3u8"
fi

if [[ ! -f "$PLAYLIST_PATH" ]]; then
  echo "No HLS playlist found at $PLAYLIST_PATH"
  exit 1
fi

SEGMENT_PATTERN="*.ts"
PLAYLIST_PATTERN="*.m3u8"
if [[ -n "$PLAYLIST_NAME" ]]; then
  SEGMENT_PATTERN="${PLAYLIST_NAME}_*.ts"
  PLAYLIST_PATTERN="${PLAYLIST_NAME}.m3u8"
fi

DESTINATION="s3://$BUCKET"
if [[ -n "$PREFIX" ]]; then
  PREFIX="${PREFIX#/}"
  PREFIX="${PREFIX%/}"
  DESTINATION="$DESTINATION/$PREFIX"
fi

echo "Uploading HLS media to $DESTINATION"

# Media can be cached for a long time because each publishing run should use a
# new prefix (for example, videos/<video-id>/<version>/).
aws s3 sync "$OUTPUT_DIR" "$DESTINATION" \
  --exclude "*" --include "$SEGMENT_PATTERN" \
  --content-type "video/mp2t" \
  --cache-control "public, max-age=31536000, immutable"

# WebVTT subtitles are optional, but this keeps them playable if present.
aws s3 sync "$OUTPUT_DIR" "$DESTINATION" \
  --exclude "*" --include "*.vtt" \
  --content-type "text/vtt" \
  --cache-control "public, max-age=31536000, immutable"

# Upload manifests last and give them a short cache lifetime: they can change
# while the media segments remain cacheable.
aws s3 sync "$OUTPUT_DIR" "$DESTINATION" \
  --exclude "*" --include "$PLAYLIST_PATTERN" \
  --content-type "application/vnd.apple.mpegurl" \
  --cache-control "public, max-age=60, must-revalidate"

echo "Upload complete: $DESTINATION/$(basename "$PLAYLIST_PATH")"
