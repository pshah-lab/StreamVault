#!/usr/bin/env bash

# ──────────────────────────────────────────────────────────────────────────────
# pipeline.sh — End-to-end video pipeline.
#
# Scans `input/` for new video files, uploads them to S3, launches EC2
# workers to chunk each one into HLS, waits for completion, updates the
# movie catalog (movies.json), rebuilds and deploys the web viewer.
#
# Usage:
#   pnpm pipeline                    # scan input/, process new videos
#   pnpm pipeline -- --force         # reprocess ALL videos in input/
#
# Environment overrides:
#   AWS_PROFILE           (default: reactUser)
#   BUCKET                (default: your-s3-bucket-name)
#   OUTPUT_BASE           (default: output)  — S3 prefix root for HLS output
#   EC2_POLL_INTERVAL     (default: 60)      — seconds between EC2 state polls
#   EC2_TIMEOUT_MINUTES   (default: 60)      — max minutes to wait per instance
#   SKIP_DEPLOY           set to 1 to skip the final web deploy
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Configuration ──
export AWS_PROFILE="${AWS_PROFILE:-reactUser}"
if [[ -z "${BUCKET:-}" ]] && [[ -f stack-outputs.json ]]; then
  BUCKET="$(node -e 'try { const o=JSON.parse(require("fs").readFileSync("stack-outputs.json")); console.log(o.BucketName || o.Bucket || ""); } catch(e){}' 2>/dev/null || true)"
fi
BUCKET="${BUCKET:-***REMOVED***}"
REGION="${AWS_REGION:-ap-south-1}"
OUTPUT_BASE="${OUTPUT_BASE:-output}"
EC2_POLL_INTERVAL="${EC2_POLL_INTERVAL:-60}"
EC2_TIMEOUT_MINUTES="${EC2_TIMEOUT_MINUTES:-60}"
CATALOG="$PROJECT_ROOT/movies.json"
INPUT_DIR="$PROJECT_ROOT/input"
FORCE=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --) ;;  # skip pnpm separator
  esac
done

# Read distribution ID from stack-outputs.json
if [[ -f stack-outputs.json ]]; then
  DISTRIBUTION_ID="$(node -e "console.log(require('./stack-outputs.json').ExistingDistributionId)")"
else
  echo "Error: stack-outputs.json not found."
  exit 1
fi

# Fetch EC2 subnet and security group from CloudFormation stack outputs
# (required because ap-south-1 has no default VPC)
if [[ -z "${EC2_SUBNET_ID:-}" || -z "${EC2_SECURITY_GROUP_ID:-}" ]]; then
  echo "Fetching EC2 network config from CloudFormation..."
  CFN_OUTPUTS="$(aws cloudformation describe-stacks \
    --stack-name VideoAuthStack \
    --region "$REGION" \
    --query "Stacks[0].Outputs" \
    --output json 2>/dev/null || echo "[]")"

  if [[ "$CFN_OUTPUTS" != "[]" ]]; then
    EC2_SUBNET_ID="${EC2_SUBNET_ID:-$(echo "$CFN_OUTPUTS" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        const o=JSON.parse(d); const v=o.find(x=>x.OutputKey==='Ec2WorkerSubnetId');
        console.log(v?v.OutputValue:'');
      })")}"
    EC2_SECURITY_GROUP_ID="${EC2_SECURITY_GROUP_ID:-$(echo "$CFN_OUTPUTS" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        const o=JSON.parse(d); const v=o.find(x=>x.OutputKey==='Ec2WorkerSecurityGroupId');
        console.log(v?v.OutputValue:'');
      })")}"
  fi
fi

if [[ -z "${EC2_SUBNET_ID:-}" || -z "${EC2_SECURITY_GROUP_ID:-}" ]]; then
  echo "Error: Could not determine EC2_SUBNET_ID or EC2_SECURITY_GROUP_ID."
  echo "Set them manually: EC2_SUBNET_ID=subnet-xxx EC2_SECURITY_GROUP_ID=sg-xxx pnpm pipeline"
  exit 1
fi
export EC2_SUBNET_ID EC2_SECURITY_GROUP_ID

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Pratham Cinema — End-to-End Pipeline               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Profile:       $AWS_PROFILE"
echo "  Bucket:        $BUCKET"
echo "  Distribution:  $DISTRIBUTION_ID"
echo "  EC2 Subnet:    $EC2_SUBNET_ID"
echo "  EC2 SG:        $EC2_SECURITY_GROUP_ID"
echo "  Input dir:     $INPUT_DIR"
echo "  Force mode:    $FORCE"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Scan for new videos
# ──────────────────────────────────────────────────────────────────────────────

echo "━━━ Step 1: Scanning for new videos ━━━"
echo ""

# Get existing source files from catalog
EXISTING_SOURCES="$(node -e "
  const catalog = require('./movies.json');
  catalog.forEach(m => console.log(m.sourceFile));
")"

# Find video files in input/
NEW_VIDEOS=()
shopt -s nullglob
for video_path in "$INPUT_DIR"/*.{mp4,mkv,avi,mov,webm,m4v}; do
  [[ "$(basename "$video_path")" == ".DS_Store" ]] && continue
  relative="input/$(basename "$video_path")"

  if [[ "$FORCE" == "true" || "$EXISTING_SOURCES" != *"$relative"* ]]; then
    NEW_VIDEOS+=("$video_path")
  fi
done
shopt -u nullglob

if [[ ${#NEW_VIDEOS[@]} -eq 0 ]]; then
  echo "  No local videos found. Scanning S3 input/ directory..."
  S3_FILES="$(aws s3 ls "s3://$BUCKET/input/" --region "$REGION" | grep -iE "\.(mp4|mkv|avi|mov|webm|m4v)$" || true)"
  
  if [[ -z "$S3_FILES" ]]; then
    echo "  No new videos found locally or in S3 input/."
    echo "  Place .mp4/.mkv/.mov files in local input/ or s3://$BUCKET/input/ and run again."
    echo ""
    exit 0
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    filename="$(echo "$line" | awk '{$1=$2=$3=""; print $0}' | sed 's/^[[:space:]]*//')"
    [[ -z "$filename" ]] && continue
    
    relative="input/$filename"
    if [[ "$FORCE" == "true" || "$EXISTING_SOURCES" != *"$relative"* ]]; then
      NEW_VIDEOS+=("$relative")
    fi
  done <<< "$S3_FILES"
fi

if [[ ${#NEW_VIDEOS[@]} -eq 0 ]]; then
  echo "  No new videos to process (all found in S3 are already in catalog)."
  exit 0
fi

echo "  Found ${#NEW_VIDEOS[@]} new video(s):"
for v in "${NEW_VIDEOS[@]}"; do
  echo "    • $(basename "$v")"
done
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Upload source videos to S3
# ──────────────────────────────────────────────────────────────────────────────

echo "━━━ Step 2: Uploading source videos to S3 ━━━"
echo ""

for i in "${!NEW_VIDEOS[@]}"; do
  video_path="${NEW_VIDEOS[$i]}"
  filename="$(basename "$video_path")"
  s3_key="input/$filename"

  if [[ ! -f "$video_path" ]]; then
    # S3-only flow
    s3_exists=$(aws s3api head-object --bucket "$BUCKET" --key "$s3_key" --region "$REGION" >/dev/null 2>&1 && echo "true" || echo "false")
    if [[ "$s3_exists" == "true" ]]; then
      echo "  ⏭  $filename exists in S3 (local file deleted). Skipping upload."
    else
      echo "  ❌ $filename is missing locally and not found in S3!"
      exit 1
    fi
  else
    # Check if file exists in S3 with same size
    local_size=$(stat -f%z "$video_path" 2>/dev/null || stat -c%s "$video_path" 2>/dev/null || echo 0)
    s3_size=$(aws s3api head-object --bucket "$BUCKET" --key "$s3_key" --region "$REGION" --query "ContentLength" --output text 2>/dev/null || echo 0)

    if [[ "$s3_size" == "$local_size" && "$local_size" -gt 0 ]]; then
      echo "  ⏭  $filename already exists in S3 with matching size ($local_size bytes). Skipping upload."
    else
      echo "  📤 Uploading $filename → s3://$BUCKET/$s3_key ..."
      aws s3 cp "$video_path" "s3://$BUCKET/$s3_key" --region "$REGION"
      echo "     ✅ Uploaded"
    fi
  fi
done
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Verify S3 uploads
# ──────────────────────────────────────────────────────────────────────────────

echo "━━━ Step 3: Verifying S3 uploads ━━━"
echo ""
UPLOAD_SUCCESS=true

for i in "${!NEW_VIDEOS[@]}"; do
  video_path="${NEW_VIDEOS[$i]}"
  filename="$(basename "$video_path")"
  s3_key="input/$filename"

  if [[ ! -f "$video_path" ]]; then
    s3_exists=$(aws s3api head-object --bucket "$BUCKET" --key "$s3_key" --region "$REGION" >/dev/null 2>&1 && echo "true" || echo "false")
    if [[ "$s3_exists" == "true" ]]; then
      echo "  ✅ $filename verified in S3"
    else
      echo "  ❌ $filename not found in S3."
      UPLOAD_SUCCESS=false
    fi
  else
    local_size=$(stat -f%z "$video_path" 2>/dev/null || stat -c%s "$video_path" 2>/dev/null || echo 0)
    s3_size=$(aws s3api head-object --bucket "$BUCKET" --key "$s3_key" --region "$REGION" --query "ContentLength" --output text 2>/dev/null || echo 0)

    if [[ "$s3_size" != "$local_size" ]]; then
      echo "  ⚠️  $filename is incomplete or missing in S3 (Local: $local_size, S3: $s3_size). Retrying upload..."
      aws s3 cp "$video_path" "s3://$BUCKET/$s3_key" --region "$REGION"
      
      # Re-verify
      s3_size=$(aws s3api head-object --bucket "$BUCKET" --key "$s3_key" --region "$REGION" --query "ContentLength" --output text 2>/dev/null || echo 0)
      if [[ "$s3_size" != "$local_size" ]]; then
        echo "  ❌ Failed to upload and verify $filename."
        UPLOAD_SUCCESS=false
      else
        echo "     ✅ $filename verified after retry ($s3_size bytes)"
      fi
    else
      echo "  ✅ $filename verified ($s3_size bytes)"
    fi
  fi
done

if [[ "$UPLOAD_SUCCESS" != "true" ]]; then
  echo ""
  echo "Error: One or more video uploads failed verification. Aborting."
  exit 1
fi
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Collect metadata for each video
# ──────────────────────────────────────────────────────────────────────────────

echo "━━━ Step 4: Collecting movie metadata ━━━"
echo ""

declare -a VIDEO_TITLES
declare -a VIDEO_SUBTITLES
declare -a VIDEO_YEARS
declare -a VIDEO_HLS_NAMES
declare -a VIDEO_IDS
declare -a VIDEO_MULTI_AUDIOS
declare -a VIDEO_SUBTITLES_ENABLED

for video_path in "${NEW_VIDEOS[@]}"; do
  filename="$(basename "$video_path")"
  name_no_ext="${filename%.*}"

  # Clean up common tags from filename before deriving HLS name
  clean_name="$name_no_ext"
  clean_name=$(echo "$clean_name" | sed -E 's/\([0-9]{4}\).*//')
  clean_name=$(echo "$clean_name" | sed -E 's/(Dual Audio|1080p|720p|BluRay|BRRip|HDRip|WEBRip|WEB-DL|ESub|BollYFlix|\{|\[).*//I')
  clean_name=$(echo "$clean_name" | sed -E 's/[[:space:]_-]+$//')

  # Derive a URL-safe HLS name from the filename
  hls_name="$(echo "$clean_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')"

  echo "  ╭─── $filename ───╮"
  echo "  │"

  read -rp "  │  Title (e.g. My Movie): " input_title
  title="${input_title:-$name_no_ext}"

  read -rp "  │  Subtitle (e.g. The Sequel): " input_subtitle
  subtitle="${input_subtitle:-}"

  read -rp "  │  Year (e.g. 2024): " input_year
  year="${input_year:-$(date +%Y)}"

  read -rp "  │  HLS name [$hls_name]: " input_hls
  hls_name="${input_hls:-$hls_name}"

  # Check if video has multiple audio languages and subtitles locally (using ffprobe)
  is_multi_audio=false
  is_subtitles=false

  if [[ -f "$video_path" ]]; then
    if command -v ffprobe >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/ffprobe ]]; then
      FFPROBE_BIN="ffprobe"
      [[ -x /opt/homebrew/bin/ffprobe ]] && FFPROBE_BIN="/opt/homebrew/bin/ffprobe"
      
      # Detect multiple audio streams
      AUDIO_COUNT="$($FFPROBE_BIN -v error -select_streams a -show_entries stream=index -of csv=p=0 "$video_path" 2>/dev/null | wc -l | tr -d ' ' || echo "1")"
      if [[ -n "$AUDIO_COUNT" && "$AUDIO_COUNT" -gt 1 ]]; then
        is_multi_audio=true
      fi

      # Detect text subtitles
      SUB_STREAMS="$($FFPROBE_BIN -v error -select_streams s -show_entries stream=index:codec_name -of csv=p=0 "$video_path" 2>/dev/null || true)"
      if [[ -n "$SUB_STREAMS" ]]; then
        while IFS= read -r line; do
          [[ -z "$line" ]] && continue
          CODEC="$(echo "$line" | awk -F, '{print $2}' | tr -d ' ')"
          if [[ -n "$CODEC" ]]; then
            is_subtitles=true
            break
          fi
        done <<< "$SUB_STREAMS"
      fi
    fi
  else
    # Filename fallback if local file is missing (S3-only input)
    if [[ "$filename" =~ [dD]ual.[aA]udio || "$filename" =~ [mM]ulti.[aA]udio || "$filename" =~ [dD]ual[aA]udio || "$filename" =~ [mM]ulti[aA]udio ]]; then
      is_multi_audio=true
    fi
    if [[ "$filename" =~ [eE][sS]ub || "$filename" =~ [sS]ubtitle || "$filename" =~ [sS]ub ]]; then
      is_subtitles=true
    fi
  fi

  multi_audio_val="$is_multi_audio"
  subtitles_val="$is_subtitles"

  # Generate a unique ID from hls_name
  video_id="$hls_name"

  echo "  │"
  echo "  │  ID:          $video_id"
  echo "  │  HLS name:    $hls_name"
  echo "  │  Multi-Audio: $multi_audio_val"
  echo "  │  Subtitles:   $subtitles_val"
  echo "  │  Output:      $OUTPUT_BASE/$hls_name/"
  echo "  ╰──────────────────────╯"
  echo ""

  VIDEO_TITLES+=("$title")
  VIDEO_SUBTITLES+=("$subtitle")
  VIDEO_YEARS+=("$year")
  VIDEO_HLS_NAMES+=("$hls_name")
  VIDEO_IDS+=("$video_id")
  VIDEO_MULTI_AUDIOS+=("$multi_audio_val")
  VIDEO_SUBTITLES_ENABLED+=("$subtitles_val")
done
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Process videos in batches of 2 (respecting AWS 16 vCPU limit)
# ──────────────────────────────────────────────────────────────────────────────

echo "━━━ Step 5: Processing videos in batches ━━━"
echo ""

BATCH_SIZE="${BATCH_SIZE:-2}"
NUM_VIDEOS=${#NEW_VIDEOS[@]}

for (( batch_start=0; batch_start<NUM_VIDEOS; batch_start+=BATCH_SIZE )); do
  batch_end=$(( batch_start + BATCH_SIZE - 1 ))
  [[ $batch_end -ge $NUM_VIDEOS ]] && batch_end=$(( NUM_VIDEOS - 1 ))

  echo "========================================================================="
  echo "📦 Processing Batch: movies $((batch_start+1)) to $((batch_end+1)) of $NUM_VIDEOS"
  echo "========================================================================="
  echo ""

  # ── Launch workers for this batch ──
  declare -a BATCH_INSTANCE_IDS=()
  declare -a BATCH_VIDEO_PATHS=()
  declare -a BATCH_FILENAMES=()
  declare -a BATCH_HLS_NAMES=()
  declare -a BATCH_IDS_ARR=()
  declare -a BATCH_TITLES_ARR=()
  declare -a BATCH_SUBTITLES_ARR=()
  declare -a BATCH_YEARS_ARR=()
  declare -a BATCH_MULTI_AUDIOS_ARR=()
  declare -a BATCH_SUBTITLES_ENABLED_ARR=()

  for (( i=batch_start; i<=batch_end; i++ )); do
    video_path="${NEW_VIDEOS[$i]}"
    filename="$(basename "$video_path")"
    hls_name="${VIDEO_HLS_NAMES[$i]}"
    output_prefix="$OUTPUT_BASE/$hls_name"

    BATCH_VIDEO_PATHS+=("$video_path")
    BATCH_FILENAMES+=("$filename")
    BATCH_HLS_NAMES+=("$hls_name")
    BATCH_IDS_ARR+=("${VIDEO_IDS[$i]}")
    BATCH_TITLES_ARR+=("${VIDEO_TITLES[$i]}")
    BATCH_SUBTITLES_ARR+=("${VIDEO_SUBTITLES[$i]}")
    BATCH_YEARS_ARR+=("${VIDEO_YEARS[$i]}")
    BATCH_MULTI_AUDIOS_ARR+=("${VIDEO_MULTI_AUDIOS[$i]}")
    BATCH_SUBTITLES_ENABLED_ARR+=("${VIDEO_SUBTITLES_ENABLED[$i]}")

    # Check if an EC2 worker is already running for this video
    EXISTING_INSTANCE_ID="$(aws ec2 describe-instances \
      --region "$REGION" \
      --filters "Name=tag:Project,Values=hls-video-chunker" "Name=tag:HlsName,Values=$hls_name" "Name=instance-state-name,Values=running,pending" \
      --query "Reservations[*].Instances[0].InstanceId" \
      --output text 2>/dev/null || echo "")"

    if [[ -n "$EXISTING_INSTANCE_ID" && "$EXISTING_INSTANCE_ID" != "None" ]]; then
      echo "  ⏭  EC2 worker is already running for $hls_name ($EXISTING_INSTANCE_ID). Re-attaching."
      INSTANCE_ID="$EXISTING_INSTANCE_ID"
    else
      echo "  🚀 Launching EC2 worker for $hls_name ..."

      INSTANCE_ID="$(
        AWS_PROFILE="$AWS_PROFILE" \
        AWS_REGION="$REGION" \
        EC2_SUBNET_ID="$EC2_SUBNET_ID" \
        EC2_SECURITY_GROUP_ID="$EC2_SECURITY_GROUP_ID" \
        CLOUDFRONT_DISTRIBUTION_ID="$DISTRIBUTION_ID" \
        bash scripts/launch-ec2-chunk-job.sh \
          "$BUCKET" "input/$filename" "$hls_name" "$output_prefix" \
        2>&1 | tee /dev/stderr | grep "Started EC2 worker:" | awk '{print $NF}'
      )"

      if [[ -z "$INSTANCE_ID" ]]; then
        echo "     ❌ Failed to launch EC2 instance for $hls_name"
        exit 1
      fi
      echo "     Instance: $INSTANCE_ID"
    fi
    BATCH_INSTANCE_IDS+=("$INSTANCE_ID")
    echo ""
  done

  # ── Wait for batch EC2 instances to finish ──
  echo "━━━ Waiting for batch workers to complete ━━━"
  echo ""
  echo "  Polling every ${EC2_POLL_INTERVAL}s (timeout: ${EC2_TIMEOUT_MINUTES}m)"
  echo "  Workers self-terminate after chunking + uploading."
  echo ""
  
  MAX_POLLS=$(( EC2_TIMEOUT_MINUTES * 60 / EC2_POLL_INTERVAL ))
  PENDING_IDS=("${BATCH_INSTANCE_IDS[@]}")

  for (( poll=1; poll<=MAX_POLLS; poll++ )); do
    STILL_RUNNING=()

    for instance_id in "${PENDING_IDS[@]}"; do
      STATE="$(aws ec2 describe-instances \
        --region "$REGION" \
        --instance-ids "$instance_id" \
        --query "Reservations[0].Instances[0].State.Name" \
        --output text 2>/dev/null || echo "unknown")"

      if [[ "$STATE" == "terminated" || "$STATE" == "shutting-down" ]]; then
        HLS_INDEX=""
        for j in "${!BATCH_INSTANCE_IDS[@]}"; do
          if [[ "${BATCH_INSTANCE_IDS[$j]}" == "$instance_id" ]]; then
            HLS_INDEX="$j"
            break
          fi
        done
        hls_name="${BATCH_HLS_NAMES[$HLS_INDEX]}"
        echo "  ✅ $instance_id ($hls_name) — $STATE"
      elif [[ "$STATE" == "running" || "$STATE" == "pending" ]]; then
        STILL_RUNNING+=("$instance_id")
      else
        echo "  ⚠️  $instance_id — unexpected state: $STATE"
        STILL_RUNNING+=("$instance_id")
      fi
    done

    if [[ ${#STILL_RUNNING[@]} -eq 0 ]]; then
      echo ""
      echo "  All workers in this batch have finished!"
      break
    fi

    PENDING_IDS=("${STILL_RUNNING[@]}")
    echo "  ⏳ ${#STILL_RUNNING[@]} worker(s) still running... (poll $poll/$MAX_POLLS)"
    sleep "$EC2_POLL_INTERVAL"
  done

  if [[ ${#STILL_RUNNING[@]:-0} -gt 0 ]]; then
    echo ""
    echo "  ⚠️  Timeout reached. ${#STILL_RUNNING[@]} worker(s) may still be running."
  fi
  echo ""

  # ── Verify batch HLS outputs ──
  echo "━━━ Verifying HLS output for this batch ━━━"
  echo ""
  
  VERIFIED_COUNT=0
  for (( idx=0; idx<${#BATCH_VIDEO_PATHS[@]}; idx++ )); do
    hls_name="${BATCH_HLS_NAMES[$idx]}"
    output_prefix="$OUTPUT_BASE/$hls_name"
    playlist_key="$output_prefix/$hls_name.m3u8"

    if aws s3api head-object --bucket "$BUCKET" --key "$playlist_key" --region "$REGION" >/dev/null 2>&1; then
      echo "  ✅ s3://$BUCKET/$playlist_key"
      VERIFIED_COUNT=$((VERIFIED_COUNT + 1))
    else
      echo "  ❌ s3://$BUCKET/$playlist_key — NOT FOUND"
      echo "     The EC2 worker may have failed. Check the instance system log."
    fi
  done
  echo ""

  # ── Update movies.json for verified batch items ──
  if [[ $VERIFIED_COUNT -gt 0 ]]; then
    echo "━━━ Updating movies.json with batch results ━━━"
    echo ""

    for (( idx=0; idx<${#BATCH_VIDEO_PATHS[@]}; idx++ )); do
      hls_name="${BATCH_HLS_NAMES[$idx]}"
      filename="${BATCH_FILENAMES[$idx]}"
      output_prefix="$OUTPUT_BASE/$hls_name"
      playlist_key="$output_prefix/$hls_name.m3u8"

      # Only add if the playlist was verified
      if ! aws s3api head-object --bucket "$BUCKET" --key "$playlist_key" --region "$REGION" >/dev/null 2>&1; then
        echo "  ⏭  Skipping $hls_name (playlist not found)"
        continue
      fi

      # Delete raw input source video from S3
      echo "  🧹 Deleting raw input source video: s3://$BUCKET/input/$filename"
      aws s3 rm "s3://$BUCKET/input/$filename" --region "$REGION" >/dev/null || true

      # Fetch official theatrical poster from internet
      echo "  🖼  Fetching official theatrical poster for ${BATCH_TITLES_ARR[$idx]}..."
      python3 -c "
import urllib.request, urllib.parse, json, os
title = '''${BATCH_TITLES_ARR[$idx]}'''
hls_name = '${BATCH_HLS_NAMES[$idx]}'
poster_path = f'$PROJECT_ROOT/web/public/posters/{hls_name}.jpg'
os.makedirs(os.path.dirname(poster_path), exist_ok=True)
url = f'https://www.omdbapi.com/?t={urllib.parse.quote(title)}&apikey=trilogy'
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        if data.get('Poster') and data.get('Poster') != 'N/A':
            img_req = urllib.request.Request(data['Poster'], headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(img_req) as img_resp:
                with open(poster_path, 'wb') as img_file:
                    img_file.write(img_resp.read())
            print(f'     ✅ Saved official poster to web/public/posters/{hls_name}.jpg')
except Exception as e:
    print(f'     ⚠️ Poster fetch note: {e}')
" || true

      node -e "
        const fs = require('fs');
        const catalog = JSON.parse(fs.readFileSync('$CATALOG', 'utf8'));

        if (catalog.some(m => m.id === '${BATCH_IDS_ARR[$idx]}')) {
          console.log('  ⏭  ${BATCH_IDS_ARR[$idx]} already in catalog');
          process.exit(0);
        }

        catalog.push({
          id: '${BATCH_IDS_ARR[$idx]}',
          title: $(node -e "process.stdout.write(JSON.stringify('${BATCH_TITLES_ARR[$idx]}'))"),
          subtitle: $(node -e "process.stdout.write(JSON.stringify('${BATCH_SUBTITLES_ARR[$idx]}'))"),
          year: ${BATCH_YEARS_ARR[$idx]},
          hlsName: '${BATCH_HLS_NAMES[$idx]}',
          outputPrefix: '$output_prefix',
          sourceFile: 'input/$filename',
          multiAudio: ${BATCH_MULTI_AUDIOS_ARR[$idx]},
          subtitles: ${BATCH_SUBTITLES_ENABLED_ARR[$idx]},
          poster: 'posters/${BATCH_HLS_NAMES[$idx]}.jpg'
        });

        fs.writeFileSync('$CATALOG', JSON.stringify(catalog, null, 2) + '\n');
        console.log('  ✅ Added ${BATCH_IDS_ARR[$idx]} to movies.json');
      "
    done
    echo ""

    # ── Deploy batch updates ──
    if [[ "${SKIP_DEPLOY:-}" == "1" ]]; then
      echo "━━━ Skipping deploy (SKIP_DEPLOY=1) ━━━"
    else
      echo "━━━ Deploying updated viewer with batch results ━━━"
      echo ""
      bash "$SCRIPT_DIR/deploy-web.sh" "$BUCKET"
    fi
    echo ""
  fi
done

# ──────────────────────────────────────────────────────────────────────────────
# Done!
# ──────────────────────────────────────────────────────────────────────────────

VIEWER_DOMAIN="${VIEWER_DOMAIN:-your-cloudfront-domain.cloudfront.net}"
if [[ -f stack-outputs.json ]]; then
  STACK_DOMAIN="$(node -e 'try { const o=JSON.parse(require("fs").readFileSync("stack-outputs.json")); console.log(o.ViewerDomain || ""); } catch(e){}' 2>/dev/null || true)"
  if [[ -n "$STACK_DOMAIN" ]]; then
    VIEWER_DOMAIN="$STACK_DOMAIN"
  fi
fi
echo "  Viewer: https://${VIEWER_DOMAIN}/app/index.html"
echo "═══════════════════════════════════════════════════════════════"
echo ""
