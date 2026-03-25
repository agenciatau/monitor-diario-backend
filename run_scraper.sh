#!/bin/bash
# Daily cron wrapper for pdfs_scraper.py
# Add to crontab with: crontab -e
#   0 6 * * 1-5 /Users/victorgois/Repositories/tatu/run_scraper.sh >> /Users/victorgois/Repositories/tatu/logs/scraper.log 2>&1

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$REPO_DIR"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Starting scraper ==="

source .venv/bin/activate 2>/dev/null || true

python pdfs_scraper.py

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Scraper finished ==="

echo "=== $(date '+%Y-%m-%d %H:%M:%S') Syncing PDFs to Vector Store ==="
python upload_pdfs.py
echo "=== $(date '+%Y-%m-%d %H:%M:%S') Vector Store sync finished ==="
