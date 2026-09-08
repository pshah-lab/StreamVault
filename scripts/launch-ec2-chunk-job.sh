#!/usr/bin/env bash

# Launch a one-shot on-demand EC2 worker that downloads a source video from S3,
# converts it to HLS, uploads the result, invalidates CloudFront, and shuts down.

set -euo pipefail

BUCKET="${1:-}"
INPUT_KEY_OR_URI="${2:-}"
HLS_NAME="${3:-}"
OUTPUT_PREFIX="${4:-output}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -o allexport
  source "$PROJECT_ROOT/.env"
  set +o allexport
fi

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${EC2_INSTANCE_TYPE:-c7i.2xlarge}"
INSTANCE_PROFILE_NAME="${EC2_INSTANCE_PROFILE_NAME:-hls-video-chunker-ec2-worker}"
DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"
if [[ -z "$DISTRIBUTION_ID" && -f stack-outputs.json ]]; then
  DISTRIBUTION_ID="$(node -e 'try { const o=JSON.parse(require("fs").readFileSync("stack-outputs.json")); console.log(o.ExistingDistributionId || o.ExistingDistributionIdOutput || ""); } catch(e){}' 2>/dev/null || true)"
fi
AMI_PARAMETER="${EC2_AMI_PARAMETER:-/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}"
SUBNET_ID="${EC2_SUBNET_ID:-${Public_Subnet_ID:-${PUBLIC_SUBNET_ID:-}}}"
SECURITY_GROUP_ID="${EC2_SECURITY_GROUP_ID:-${Security_Group_ID:-${SECURITY_GROUP_ID:-}}}"
VPC_ID="${EC2_VPC_ID:-${VPC_ID:-}}"
VOLUME_SIZE_GB="${EC2_VOLUME_SIZE_GB:-120}"

if [[ -z "$BUCKET" || -z "$INPUT_KEY_OR_URI" || -z "$HLS_NAME" ]]; then
  echo "Usage: pnpm chunk:ec2 -- <bucket-name> <input-key-or-s3-uri> <hls-name> [output-prefix]"
  echo "Example: AWS_PROFILE=myProfile pnpm chunk:ec2 -- my-s3-bucket input/my-video.mp4 my-video output"
  exit 1
fi

if [[ "$BUCKET" == "--" ]]; then
  shift
  exec "$0" "$@"
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required."
  exit 1
fi

if [[ ! "$HLS_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  echo "HLS name may contain only letters, numbers, hyphens, and underscores."
  exit 1
fi

INPUT_KEY="$INPUT_KEY_OR_URI"
if [[ "$INPUT_KEY_OR_URI" == s3://* ]]; then
  WITHOUT_SCHEME="${INPUT_KEY_OR_URI#s3://}"
  INPUT_BUCKET="${WITHOUT_SCHEME%%/*}"
  INPUT_KEY="${WITHOUT_SCHEME#*/}"
  if [[ "$INPUT_BUCKET" != "$BUCKET" ]]; then
    echo "Input URI bucket '$INPUT_BUCKET' does not match target bucket '$BUCKET'."
    exit 1
  fi
fi

OUTPUT_PREFIX="${OUTPUT_PREFIX#/}"
OUTPUT_PREFIX="${OUTPUT_PREFIX%/}"

# ── Security: validate INPUT_KEY and OUTPUT_PREFIX (CWE-78) ──
# Only allow characters safe for S3 keys AND shell interpolation.
# Blocks shell metacharacters (`, $, ;, |, &, etc.) from reaching
# the EC2 user-data heredoc where these values run as root.
SAFE_S3_KEY_RE='^[a-zA-Z0-9._/-]+$'
if [[ ! "$INPUT_KEY" =~ $SAFE_S3_KEY_RE ]]; then
  echo "Error: INPUT_KEY contains unsafe characters: $INPUT_KEY"
  exit 1
fi
if [[ ! "$OUTPUT_PREFIX" =~ $SAFE_S3_KEY_RE ]]; then
  echo "Error: OUTPUT_PREFIX contains unsafe characters: $OUTPUT_PREFIX"
  exit 1
fi

if ! aws s3api head-object --bucket "$BUCKET" --key "$INPUT_KEY" --region "$REGION" >/dev/null 2>&1; then
  echo "Input file not found: s3://$BUCKET/$INPUT_KEY"
  echo "Upload it first, for example:"
  echo "  aws s3 cp input/video.mp4 s3://$BUCKET/$INPUT_KEY"
  exit 1
fi

if [[ -z "$SUBNET_ID" ]]; then
  DEFAULT_VPC_COUNT="$(aws ec2 describe-vpcs \
    --region "$REGION" \
    --filters Name=is-default,Values=true \
    --query 'length(Vpcs)' \
    --output text)"
  if [[ "$DEFAULT_VPC_COUNT" == "0" ]]; then
    echo "No default VPC exists in $REGION. Pass the worker subnet and security group from the CDK outputs:"
    echo "  EC2_SUBNET_ID=<Ec2WorkerSubnetId> EC2_SECURITY_GROUP_ID=<Ec2WorkerSecurityGroupId> pnpm chunk:ec2 -- $BUCKET $INPUT_KEY $HLS_NAME $OUTPUT_PREFIX"
    exit 1
  fi
fi

if [[ "$SUBNET_ID" == *"<"* || "$SUBNET_ID" == *">"* || "$SECURITY_GROUP_ID" == *"<"* || "$SECURITY_GROUP_ID" == *">"* ]]; then
  echo "Do not paste angle-bracket placeholders. Use the real CDK output values."
  echo "Example:"
  echo "  EC2_SUBNET_ID=subnet-abc123 EC2_SECURITY_GROUP_ID=sg-abc123 pnpm chunk:ec2 -- $BUCKET $INPUT_KEY $HLS_NAME $OUTPUT_PREFIX"
  exit 1
fi

USER_DATA_FILE="$(mktemp)"
cleanup() {
  rm -f "$USER_DATA_FILE"
}
trap cleanup EXIT

cat >"$USER_DATA_FILE" <<USER_DATA
#!/usr/bin/env bash
set -euo pipefail

exec > >(tee /var/log/hls-ec2-worker.log | logger -t hls-ec2-worker -s 2>/dev/console) 2>&1

BUCKET="$BUCKET"
INPUT_KEY="$INPUT_KEY"
HLS_NAME="$HLS_NAME"
OUTPUT_PREFIX="$OUTPUT_PREFIX"
DISTRIBUTION_ID="$DISTRIBUTION_ID"
REGION="$REGION"

TOKEN="\$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' || true)"
if [[ -n "\$TOKEN" ]]; then
  INSTANCE_ID="\$(curl -fsS -H "X-aws-ec2-metadata-token: \$TOKEN" http://169.254.169.254/latest/meta-data/instance-id || true)"
else
  INSTANCE_ID="\$(curl -fsS http://169.254.169.254/latest/meta-data/instance-id || true)"
fi

finish() {
  local status="\$?"

  # Persist worker log to S3 for post-mortem debugging (before instance terminates)
  local log_key="\${OUTPUT_PREFIX}/\${HLS_NAME}/logs/hls-ec2-worker-\$(date +%Y%m%dT%H%M%S).log"
  echo "Uploading worker log to s3://\$BUCKET/\$log_key ..."
  aws s3 cp /var/log/hls-ec2-worker.log "s3://\$BUCKET/\$log_key" --region "\$REGION" 2>/dev/null || echo "Warning: failed to upload worker log to S3."

  if [[ "\$status" -eq 0 ]]; then
    echo "HLS EC2 job finished successfully."
  else
    echo "HLS EC2 job failed with status \$status."
    echo "Log uploaded to s3://\$BUCKET/\$log_key"
  fi

  if [[ -n "\$INSTANCE_ID" ]]; then
    aws ec2 terminate-instances --region "\$REGION" --instance-ids "\$INSTANCE_ID" || true
  else
    shutdown -h now || true
  fi
}
trap finish EXIT

# Ensure root partition and filesystem are resized to the full EBS volume size
echo "Growing root partition and filesystem..."
if command -v growpart >/dev/null 2>&1; then
  growpart /dev/xvda 1 || true
fi
if command -v xfs_growfs >/dev/null 2>&1; then
  xfs_growfs / || true
elif command -v resize2fs >/dev/null 2>&1; then
  resize2fs /dev/xvda1 || true
fi
df -h

dnf update -y
dnf install -y awscli nodejs npm

WORKDIR="/opt/hls-job"
INPUT_FILE="\$WORKDIR/input/video.mp4"
OUTPUT_DIR="\$WORKDIR/output"
mkdir -p "\$(dirname "\$INPUT_FILE")" "\$OUTPUT_DIR"

aws s3 cp "s3://\$BUCKET/\$INPUT_KEY" "\$INPUT_FILE" --region "\$REGION"

cd "\$WORKDIR"
npm init -y
npm install ffmpeg-static
FFMPEG="\$(node -e 'console.log(require("ffmpeg-static"))')"

# ── Probe audio streams ──
# Get JSON array of audio streams with their index and language tag
AUDIO_STREAMS="\$(\$FFMPEG -i "\$INPUT_FILE" -hide_banner 2>&1 | grep 'Audio:' || true)"
AUDIO_COUNT="\$(echo "\$AUDIO_STREAMS" | grep -c 'Audio:' || echo 0)"

echo "Detected \$AUDIO_COUNT audio stream(s)"

# Extract unique language codes from the audio streams
AUDIO_LANGS=()
AUDIO_INDICES=()
SEEN_LANGS=""

while IFS= read -r line; do
  [[ -z "\$line" ]] && continue
  # Extract stream index: "Stream #0:1(tel)" → 1
  STREAM_IDX="\$(echo "\$line" | grep -oP 'Stream #0:\K[0-9]+')"
  # Extract language: "Stream #0:1(tel)" → tel
  LANG="\$(echo "\$line" | grep -oP 'Stream #0:[0-9]+\(\K[a-z]+' || echo "und")"

  # Skip duplicate languages (keep first occurrence — usually the higher quality one)
  if echo "\$SEEN_LANGS" | grep -qw "\$LANG"; then
    echo "  Skipping duplicate language: \$LANG (stream \$STREAM_IDX)"
    continue
  fi

  SEEN_LANGS="\$SEEN_LANGS \$LANG"
  AUDIO_LANGS+=("\$LANG")
  AUDIO_INDICES+=("\$STREAM_IDX")
  echo "  Audio track: stream #\$STREAM_IDX → \$LANG"
done <<< "\$AUDIO_STREAMS"

UNIQUE_LANG_COUNT="\${#AUDIO_LANGS[@]}"
echo "Unique languages: \$UNIQUE_LANG_COUNT"

# ── Probe subtitle streams ──
SUB_STREAMS="\$(\$FFMPEG -i "\$INPUT_FILE" -hide_banner 2>&1 | grep 'Subtitle:' || true)"
SUB_COUNT="\$(echo "\$SUB_STREAMS" | grep -c 'Subtitle:' || echo 0)"

echo "Detected \$SUB_COUNT subtitle stream(s)"

SUB_LANGS=()
SUB_INDICES=()
SEEN_SUB_LANGS=""

while IFS= read -r line; do
  [[ -z "\$line" ]] && continue
  STREAM_IDX="\$(echo "\$line" | grep -oP 'Stream #0:\K[0-9]+')"
  LANG="\$(echo "\$line" | grep -oP 'Stream #0:[0-9]+\(\K[a-z]+' || echo "und")"
  CODEC="\$(echo "\$line" | awk '{print \$4}' | sed 's/,//')"

  # Only process text subtitles (srt/subrip, ass, webvtt)
  if [[ "\$CODEC" != "subrip" && "\$CODEC" != "srt" && "\$CODEC" != "ass" && "\$CODEC" != "webvtt" ]]; then
    echo "  Skipping non-text subtitle stream \$STREAM_IDX (\$CODEC)"
    continue
  fi

  if echo "\$SEEN_SUB_LANGS" | grep -qw "\$LANG"; then
    echo "  Skipping duplicate subtitle language: \$LANG (stream \$STREAM_IDX)"
    continue
  fi

  SEEN_SUB_LANGS="\$SEEN_SUB_LANGS \$LANG"
  SUB_LANGS+=("\$LANG")
  SUB_INDICES+=("\$STREAM_IDX")
  echo "  Subtitle track: stream #\$STREAM_IDX → \$LANG (\$CODEC)"
done <<< "\$SUB_STREAMS"

UNIQUE_SUB_COUNT="\${#SUB_LANGS[@]}"
echo "Unique subtitle tracks: \$UNIQUE_SUB_COUNT"

if [[ "\$UNIQUE_LANG_COUNT" -le 1 && "\$UNIQUE_SUB_COUNT" -eq 0 ]]; then
  # ── Single audio & no subtitles: original muxed behavior ──
  echo "Single audio track & no subtitles — using muxed output"
  "\$FFMPEG" \
    -i "\$INPUT_FILE" \
    -map 0:v:0 \
    -map 0:a:0 \
    -sn \
    -dn \
    -c:v libx264 \
    -pix_fmt yuv420p \
    -c:a aac \
    -ac 2 \
    -ar 48000 \
    -preset veryfast \
    -crf 23 \
    -g 48 \
    -keyint_min 48 \
    -sc_threshold 0 \
    -hls_time 10 \
    -hls_playlist_type vod \
    -hls_flags independent_segments \
    -hls_segment_filename "\$OUTPUT_DIR/\${HLS_NAME}_%03d.ts" \
    -f hls \
    "\$OUTPUT_DIR/\${HLS_NAME}.m3u8"
else
  # ── Multi audio or has subtitles: separate video + per-language audio + subtitles renditions ──
  echo "Separate renditions mode (Audio tracks: \$UNIQUE_LANG_COUNT, Subtitle tracks: \$UNIQUE_SUB_COUNT)"

  # Step 1: Encode video-only HLS
  echo "Encoding video-only stream..."
  "\$FFMPEG" \
    -i "\$INPUT_FILE" \
    -map 0:v:0 \
    -an \
    -sn \
    -dn \
    -c:v libx264 \
    -pix_fmt yuv420p \
    -preset veryfast \
    -crf 23 \
    -g 48 \
    -keyint_min 48 \
    -sc_threshold 0 \
    -hls_time 10 \
    -hls_playlist_type vod \
    -hls_flags independent_segments \
    -hls_segment_filename "\$OUTPUT_DIR/\${HLS_NAME}_%03d.ts" \
    -f hls \
    "\$OUTPUT_DIR/\${HLS_NAME}.m3u8"

  # Step 2: Encode each audio language as a separate AAC stereo HLS stream
  for i in "\${!AUDIO_LANGS[@]}"; do
    LANG="\${AUDIO_LANGS[\$i]}"
    SIDX="\${AUDIO_INDICES[\$i]}"
    AUDIO_HLS_NAME="\${HLS_NAME}_audio_\${LANG}"

    echo "Encoding audio: \$LANG (stream #\$SIDX)..."
    "\$FFMPEG" \
      -i "\$INPUT_FILE" \
      -map "0:\$SIDX" \
      -vn \
      -c:a aac \
      -ac 2 \
      -ar 48000 \
      -b:a 192k \
      -hls_time 10 \
      -hls_playlist_type vod \
      -hls_flags independent_segments \
      -hls_segment_filename "\$OUTPUT_DIR/\${AUDIO_HLS_NAME}_%03d.ts" \
      -f hls \
      "\$OUTPUT_DIR/\${AUDIO_HLS_NAME}.m3u8"
  done

  # Step 2b: Extract and chunk each subtitle language as WebVTT HLS stream
  for i in "\${!SUB_LANGS[@]}"; do
    LANG="\${SUB_LANGS[\$i]}"
    SIDX="\${SUB_INDICES[\$i]}"
    SUB_HLS_NAME="\${HLS_NAME}_sub_\${LANG}"

    echo "Encoding subtitle: \$LANG (stream #\$SIDX)..."
    "\$FFMPEG" \
      -i "\$INPUT_FILE" \
      -map "0:\$SIDX" \
      -c:s webvtt \
      -f segment \
      -segment_time 10 \
      -segment_list_type m3u8 \
      -segment_list "\$OUTPUT_DIR/\${SUB_HLS_NAME}.m3u8" \
      -segment_format webvtt \
      "\$OUTPUT_DIR/\${SUB_HLS_NAME}_%03d.vtt" || {
        echo "  ⚠️ Failed to encode subtitle track \$LANG. Skipping."
        rm -f "\$OUTPUT_DIR/\${SUB_HLS_NAME}"*
      }
  done

  # Step 3: Build the master playlist
  echo "Building master.m3u8..."
  MASTER="\$OUTPUT_DIR/master.m3u8"
  echo "#EXTM3U" > "\$MASTER"
  echo "#EXT-X-VERSION:6" >> "\$MASTER"
  echo "" >> "\$MASTER"

  # Add audio tracks to master playlist
  DEFAULT_SET=false
  for i in "\${!AUDIO_LANGS[@]}"; do
    LANG="\${AUDIO_LANGS[\$i]}"
    AUDIO_HLS_NAME="\${HLS_NAME}_audio_\${LANG}"
    IS_DEFAULT="NO"
    if [[ "\$DEFAULT_SET" == "false" ]]; then
      IS_DEFAULT="YES"
      DEFAULT_SET=true
    fi
    echo "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"\$LANG\",LANGUAGE=\"\$LANG\",DEFAULT=\$IS_DEFAULT,AUTOSELECT=\$IS_DEFAULT,URI=\"\${AUDIO_HLS_NAME}.m3u8\"" >> "\$MASTER"
  done

  # Add subtitle tracks to master playlist
  HAS_SUBS=false
  for i in "\${!SUB_LANGS[@]}"; do
    LANG="\${SUB_LANGS[\$i]}"
    SUB_HLS_NAME="\${HLS_NAME}_sub_\${LANG}"
    if [[ -f "\$OUTPUT_DIR/\${SUB_HLS_NAME}.m3u8" ]]; then
      IS_DEFAULT="NO"
      if [[ "\$HAS_SUBS" == "false" ]]; then
        IS_DEFAULT="YES"
        HAS_SUBS=true
      fi
      echo "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"\$LANG\",LANGUAGE=\"\$LANG\",DEFAULT=\$IS_DEFAULT,AUTOSELECT=\$IS_DEFAULT,FORCED=NO,URI=\"\${SUB_HLS_NAME}.m3u8\"" >> "\$MASTER"
    fi
  done

  echo "" >> "\$MASTER"
  
  # Format stream line with both AUDIO and SUBTITLES group if they exist
  STREAM_INF="#EXT-X-STREAM-INF:BANDWIDTH=3000000"
  if [[ "\${#AUDIO_LANGS[@]}" -gt 0 ]]; then
    STREAM_INF="\$STREAM_INF,AUDIO=\"audio\""
  fi
  if [[ "\$HAS_SUBS" == "true" ]]; then
    STREAM_INF="\$STREAM_INF,SUBTITLES=\"subs\""
  fi

  echo "\$STREAM_INF" >> "\$MASTER"
  echo "\${HLS_NAME}.m3u8" >> "\$MASTER"

  echo "Master playlist created with \${#AUDIO_LANGS[@]} audio and \${#SUB_LANGS[@]} subtitle tracks (processed successfully: \$HAS_SUBS)"
fi

DESTINATION="s3://\$BUCKET/\$OUTPUT_PREFIX"

# Upload .ts segments (video + audio)
aws s3 sync "\$OUTPUT_DIR" "\$DESTINATION" \
  --exclude "*" --include "*.ts" \
  --content-type "video/mp2t" \
  --cache-control "public, max-age=31536000, immutable" \
  --region "\$REGION"

# Upload WebVTT subtitles
aws s3 sync "\$OUTPUT_DIR" "\$DESTINATION" \
  --exclude "*" --include "*.vtt" \
  --content-type "text/vtt" \
  --cache-control "public, max-age=31536000, immutable" \
  --region "\$REGION"

# Upload all .m3u8 playlists last (master + variant + audio)
aws s3 sync "\$OUTPUT_DIR" "\$DESTINATION" \
  --exclude "*" --include "*.m3u8" \
  --content-type "application/vnd.apple.mpegurl" \
  --cache-control "public, max-age=60, must-revalidate" \
  --region "\$REGION"

aws cloudfront create-invalidation \
  --distribution-id "\$DISTRIBUTION_ID" \
  --paths "/\${OUTPUT_PREFIX}/*" \
  --region us-east-1 || true
USER_DATA

AMI_ID="$(aws ssm get-parameter \
  --region "$REGION" \
  --name "$AMI_PARAMETER" \
  --query "Parameter.Value" \
  --output text)"

echo "Launching EC2 worker:"
echo "  AMI: $AMI_ID"
echo "  Type: $INSTANCE_TYPE"
echo "  Root volume: ${VOLUME_SIZE_GB} GiB"
echo "  Bucket: s3://$BUCKET"
echo "  Input: s3://$BUCKET/$INPUT_KEY"
echo "  Output: s3://$BUCKET/$OUTPUT_PREFIX/$HLS_NAME.m3u8"

NETWORK_ARGS=()
if [[ -n "$SUBNET_ID" ]]; then
  NETWORK_ARGS+=(--subnet-id "$SUBNET_ID")
fi
if [[ -n "$SECURITY_GROUP_ID" ]]; then
  NETWORK_ARGS+=(--security-group-ids "$SECURITY_GROUP_ID")
fi

INSTANCE_ID="$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
  "${NETWORK_ARGS[@]}" \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$VOLUME_SIZE_GB,VolumeType=gp3,DeleteOnTermination=true}" \
  --instance-initiated-shutdown-behavior terminate \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=hls-video-chunker-ec2},{Key=Project,Value=hls-video-chunker},{Key=HlsEc2Worker,Value=true},{Key=HlsName,Value=$HLS_NAME}]" \
  --user-data "file://$USER_DATA_FILE" \
  --query "Instances[0].InstanceId" \
  --output text)"

echo "Started EC2 worker: $INSTANCE_ID"
echo "Watch logs:"
echo "  AWS Console > EC2 > Instances > $INSTANCE_ID > System log"
echo "  or use SSM if Session Manager is enabled for this account."
