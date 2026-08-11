#!/usr/bin/env bash
# Extract subtitles locally from a video file and upload them to S3 to patch an existing stream.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -o allexport
  source "$PROJECT_ROOT/.env"
  set +o allexport
fi

BUCKET="${BUCKET:-your-s3-bucket-name}"
REGION="${AWS_REGION:-us-east-1}"
CATALOG="movies.json"

read -rp "Local video file path: " VIDEO_PATH
if [[ ! -f "$VIDEO_PATH" ]]; then
  echo "File not found: $VIDEO_PATH"
  exit 1
fi

read -rp "HLS name (must match movies.json): " HLS_NAME
# Confirm it exists in movies.json
if ! grep -qF "\"hlsName\": \"$HLS_NAME\"" "$CATALOG"; then
  echo "HLS name '$HLS_NAME' not found in movies.json!"
  exit 1
fi

FFMPEG="ffmpeg"
[[ -x /opt/homebrew/bin/ffmpeg ]] && FFMPEG="/opt/homebrew/bin/ffmpeg"
FFPROBE="ffprobe"
[[ -x /opt/homebrew/bin/ffprobe ]] && FFPROBE="/opt/homebrew/bin/ffprobe"

# Probe subtitle streams
SUB_STREAMS="$($FFPROBE -i "$VIDEO_PATH" -hide_banner 2>&1 | grep 'Subtitle:' || true)"
SUB_COUNT="$(echo "$SUB_STREAMS" | grep -c 'Subtitle:' || echo 0)"

if [[ "$SUB_COUNT" -eq 0 ]]; then
  echo "No subtitles found in $VIDEO_PATH!"
  exit 1
fi

echo "Found $SUB_COUNT subtitle stream(s):"
SUB_LANGS=()
SUB_INDICES=()
SEEN_LANGS=""

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  STREAM_IDX="$(echo "$line" | sed -E 's/.*Stream #0:([0-9]+).*/\1/')"
  LANG="$(echo "$line" | sed -n -E 's/.*Stream #0:[0-9]+\(([^)]+)\).*/\1/p')"
  [[ -z "$LANG" ]] && LANG="und"
  CODEC="$(echo "$line" | awk '{print $4}' | sed 's/,//')"

  if [[ "$CODEC" != "subrip" && "$CODEC" != "srt" && "$CODEC" != "ass" && "$CODEC" != "webvtt" ]]; then
    echo "  Skipping stream $STREAM_IDX ($CODEC) — only text subtitles are supported."
    continue
  fi

  if echo "$SEEN_LANGS" | grep -qw "$LANG"; then
    continue
  fi

  SEEN_LANGS="$SEEN_LANGS $LANG"
  SUB_LANGS+=("$LANG")
  SUB_INDICES+=("$STREAM_IDX")
  echo "  Stream #$STREAM_IDX: $LANG ($CODEC)"
done <<< "$SUB_STREAMS"

if [[ ${#SUB_LANGS[@]} -eq 0 ]]; then
  echo "No supported text subtitle tracks found!"
  exit 1
fi

# Create temp dir
TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Transcode subtitles
for i in "${!SUB_LANGS[@]}"; do
  LANG="${SUB_LANGS[$i]}"
  IDX="${SUB_INDICES[$i]}"
  SUB_HLS_NAME="${HLS_NAME}_sub_${LANG}"

  echo "Extracting and chunking $LANG subtitles..."
  "$FFMPEG" -i "$VIDEO_PATH" \
    -map "0:$IDX" \
    -c:s webvtt \
    -f segment \
    -segment_time 10 \
    -segment_list_type m3u8 \
    -segment_list "$TEMP_DIR/${SUB_HLS_NAME}.m3u8" \
    -segment_format webvtt \
    "$TEMP_DIR/${SUB_HLS_NAME}_%03d.vtt"
done

# Sync to S3
echo "Uploading subtitles to S3..."
aws s3 sync "$TEMP_DIR" "s3://$BUCKET/output/$HLS_NAME" \
  --exclude "*" --include "*.vtt" \
  --content-type "text/vtt" \
  --cache-control "public, max-age=31536000, immutable" \
  --region "$REGION"

aws s3 sync "$TEMP_DIR" "s3://$BUCKET/output/$HLS_NAME" \
  --exclude "*" --include "*.m3u8" \
  --content-type "application/vnd.apple.mpegurl" \
  --cache-control "public, max-age=60, must-revalidate" \
  --region "$REGION"

# Download and update master.m3u8
echo "Updating master.m3u8..."
aws s3 cp "s3://$BUCKET/output/$HLS_NAME/master.m3u8" "$TEMP_DIR/master.m3u8" --region "$REGION" || true

if [[ -f "$TEMP_DIR/master.m3u8" ]]; then
  # Parse existing master.m3u8 to preserve audio/video tracks
  NEW_MASTER="$TEMP_DIR/master_new.m3u8"
  echo "#EXTM3U" > "$NEW_MASTER"
  echo "#EXT-X-VERSION:6" >> "$NEW_MASTER"
  echo "" >> "$NEW_MASTER"

  # Copy existing AUDIO media declarations
  grep '^#EXT-X-MEDIA:TYPE=AUDIO' "$TEMP_DIR/master.m3u8" >> "$NEW_MASTER" || true

  # Add our new SUBTITLES media declarations
  for i in "${!SUB_LANGS[@]}"; do
    LANG="${SUB_LANGS[$i]}"
    SUB_HLS_NAME="${HLS_NAME}_sub_${LANG}"
    IS_DEFAULT="NO"
    [[ $i -eq 0 ]] && IS_DEFAULT="YES"
    echo "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"$LANG\",LANGUAGE=\"$LANG\",DEFAULT=$IS_DEFAULT,AUTOSELECT=$IS_DEFAULT,FORCED=NO,URI=\"${SUB_HLS_NAME}.m3u8\"" >> "$NEW_MASTER"
  done
  echo "" >> "$NEW_MASTER"

  # Find the STREAM-INF lines and update them
  while IFS= read -r line; do
    if [[ "$line" =~ ^#EXT-X-STREAM-INF ]]; then
      # Strip existing SUBTITLES tag if any
      clean_line="$(echo "$line" | sed -E 's/,SUBTITLES="[^"]*"//g')"
      # Append SUBTITLES tag
      echo "${clean_line},SUBTITLES=\"subs\"" >> "$NEW_MASTER"
    elif [[ "$line" =~ ^[a-zA-Z0-9_-]+\.m3u8 ]]; then
      echo "$line" >> "$NEW_MASTER"
    fi
  done < <(grep -E '^#EXT-X-STREAM-INF|[a-zA-Z0-9_-]+\.m3u8$' "$TEMP_DIR/master.m3u8")
  
  mv "$NEW_MASTER" "$TEMP_DIR/master.m3u8"
else
  # If master.m3u8 didn't exist, probe the video file for audio tracks to build it correctly
  echo "Creating new master.m3u8..."
  MASTER="$TEMP_DIR/master.m3u8"
  echo "#EXTM3U" > "$MASTER"
  echo "#EXT-X-VERSION:6" >> "$MASTER"
  echo "" >> "$MASTER"

  # Probe audio streams from local video
  AUDIO_STREAMS="$($FFPROBE -i "$VIDEO_PATH" -hide_banner 2>&1 | grep 'Audio:' || true)"
  AUDIO_LANGS=()
  SEEN_LANGS=""
  
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    LANG="$(echo "$line" | sed -n -E 's/.*Stream #0:[0-9]+\(([^)]+)\).*/\1/p')"
    [[ -z "$LANG" ]] && LANG="und"
    
    if echo "$SEEN_LANGS" | grep -qw "$LANG"; then
      continue
    fi
    SEEN_LANGS="$SEEN_LANGS $LANG"
    AUDIO_LANGS+=("$LANG")
  done <<< "$AUDIO_STREAMS"

  # Write audio renditions
  if [[ ${#AUDIO_LANGS[@]} -gt 0 ]]; then
    for i in "${!AUDIO_LANGS[@]}"; do
      LANG="${AUDIO_LANGS[$i]}"
      IS_DEFAULT="NO"
      [[ $i -eq 0 ]] && IS_DEFAULT="YES"
      echo "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"$LANG\",LANGUAGE=\"$LANG\",DEFAULT=$IS_DEFAULT,AUTOSELECT=$IS_DEFAULT,URI=\"${HLS_NAME}_audio_${LANG}.m3u8\"" >> "$MASTER"
    done
    echo "" >> "$MASTER"
  fi

  # Add subtitle tracks
  for i in "${!SUB_LANGS[@]}"; do
    LANG="${SUB_LANGS[$i]}"
    SUB_HLS_NAME="${HLS_NAME}_sub_${LANG}"
    IS_DEFAULT="NO"
    [[ $i -eq 0 ]] && IS_DEFAULT="YES"
    echo "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"$LANG\",LANGUAGE=\"$LANG\",DEFAULT=$IS_DEFAULT,AUTOSELECT=$IS_DEFAULT,FORCED=NO,URI=\"${SUB_HLS_NAME}.m3u8\"" >> "$MASTER"
  done
  echo "" >> "$MASTER"

  # Construct STREAM-INF line linking them
  STREAM_INF="#EXT-X-STREAM-INF:BANDWIDTH=3000000"
  if [[ ${#AUDIO_LANGS[@]} -gt 0 ]]; then
    STREAM_INF="${STREAM_INF},AUDIO=\"audio\""
  fi
  STREAM_INF="${STREAM_INF},SUBTITLES=\"subs\""
  
  echo "$STREAM_INF" >> "$MASTER"
  echo "${HLS_NAME}.m3u8" >> "$MASTER"
fi

# Upload updated master.m3u8
aws s3 cp "$TEMP_DIR/master.m3u8" "s3://$BUCKET/output/$HLS_NAME/master.m3u8" \
  --content-type "application/vnd.apple.mpegurl" \
  --cache-control "public, max-age=60, must-revalidate" \
  --region "$REGION"

# Update movies.json
node -e "
  const fs = require('fs');
  const catalog = JSON.parse(fs.readFileSync('$CATALOG', 'utf8'));
  const idx = catalog.findIndex(m => m.hlsName === '$HLS_NAME');
  if (idx !== -1) {
    catalog[idx].subtitles = true;
    fs.writeFileSync('$CATALOG', JSON.stringify(catalog, null, 2) + '\n');
    console.log('Updated movies.json catalog entry to enable subtitles.');
  }
"

# Invalidate CloudFront
echo "Invalidating CloudFront cache for master playlist..."
DIST_ID="$(node -e "console.log(require('./stack-outputs.json').ExistingDistributionId)")"
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/output/$HLS_NAME/master.m3u8" \
  --region "$REGION" >/dev/null

if [[ -z "${SKIP_DEPLOY:-}" ]]; then
  echo "Rebuilding and deploying viewer..."
  pnpm deploy:web
fi

echo "Subtitles patched successfully!"
