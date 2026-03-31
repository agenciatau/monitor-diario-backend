#!/bin/bash
# Daily cron wrapper for pdfs_scraper.ts
# Add to crontab with: crontab -e
#   0 6 * * 1-5 /Users/victorgois/Repositories/tatu/run_scraper.sh >> /Users/victorgois/Repositories/tatu/logs/scraper.log 2>&1

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Starting scraper ==="

deno run --allow-net --allow-read --allow-write --allow-env --unsafely-ignore-certificate-errors=dool.egba.ba.gov.br pdfs_scraper.ts

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Scraper finished ==="
