#!/usr/bin/env bash
# Deploy the Ballkour website to the VPS.
#   ./deploy.sh                 deploys ~/Documents/Code/ballkour-site
#   ./deploy.sh path/to/site    deploys another folder
set -euo pipefail

SRC="${1:-$HOME/Documents/Code/ballkour-site}"
DEST="vps:/var/www/ballkour.com/"

if [[ ! -f "$SRC/index.html" ]]; then
  echo "No index.html in $SRC" >&2
  exit 1
fi

# Keep Weblate's English source file in step with index.html
if [[ -f "$SRC/tools/extract-en.py" ]]; then
  python3 "$SRC/tools/extract-en.py" "$SRC/index.html"
fi

# Upload only what the site needs, and remove files that were deleted locally
rsync -az --delete --itemize-changes \
  --exclude tools/ --exclude README.md --exclude deploy.sh --exclude .git/ \
  -e "ssh -p 2222" \
  "$SRC"/ "$DEST"

# Confirm the live site answers
curl -fsS -o /dev/null -w "ballkour.com: HTTP %{http_code}\n" https://ballkour.com/
