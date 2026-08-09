#!/usr/bin/env bash
set -euo pipefail

target_dir="${1:-.secrets/cloudfront}"
mkdir -p "$target_dir"

openssl genrsa -out "$target_dir/private.pem" 2048
openssl rsa -in "$target_dir/private.pem" -pubout -out "$target_dir/public.pem"
chmod 600 "$target_dir/private.pem"
echo "Created $target_dir/private.pem and $target_dir/public.pem"
echo "Do not commit private.pem. Store its PEM value in the CloudFront signing secret after deployment."
