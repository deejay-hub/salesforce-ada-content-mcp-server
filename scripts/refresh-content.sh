#!/bin/bash
# Refreshes the seed data in db/init/ from the live Salesforce sites, then rebuilds the
# seed files. Safe to re-run at any time — each step either adds only what's new (blogs,
# videos) or fully replaces its slice of the seed (release notes, decision guides, dev guides).
#
#   blogs            Developer, Admin, Architect blogs + Salesforce Developers/Architects/Admins
#                    YouTube channels: adds anything newer than the seed, drops anything older
#                    than one year
#   release-notes    Latest release from help.salesforce.com (auto-detected), plus the 30
#                    persona/product summaries — summaries are only generated for a release that
#                    has none yet, unless --resummarize
#   decision-guides  architect.salesforce.com decision guides
#   dev-guides       Apex, LWC, Agentforce, Agentforce Vibes, Agentforce Mobile SDK guides
#
# Usage:
#   ./scripts/refresh-content.sh [--only blogs,release-notes,decision-guides,dev-guides] [--resummarize]
#
# Requires: node + npm deps (npm install), python3, yt-dlp (blogs step), and the claude CLI
# (release-notes step, only when summaries are generated). Takes 1-2 hours for everything,
# mostly polite page-by-page fetching. Afterwards: docker compose down -v && docker compose up --build

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

STEPS="blogs,release-notes,decision-guides,dev-guides"
RESUMMARIZE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --only) STEPS="$2"; shift 2 ;;
    --resummarize) RESUMMARIZE=true; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
has_step() { [[ ",$STEPS," == *",$1,"* ]]; }

need() { command -v "$1" >/dev/null || { echo "Missing required command: $1" >&2; exit 1; }; }
need node
need python3
has_step blogs && need yt-dlp
[ -d node_modules ] || npm ci
node scripts/download-model.mjs

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sf-content-refresh.XXXXXX")"
echo "Working directory: $WORK_DIR"
MERGE_ARGS=()
NEW_CSVS=()

if has_step blogs; then
  echo ""
  echo "== Blogs and videos"
  npx tsx scripts/ingest-latest.ts --out "$WORK_DIR/blogs-videos.csv"
  NEW_CSVS+=("$WORK_DIR/blogs-videos.csv")
fi

if has_step release-notes; then
  echo ""
  echo "== Release notes"
  read -r RELEASE NUMBER < <(npx tsx scripts/ingest-release-notes.ts --print-latest)
  echo "Latest release: $RELEASE ($NUMBER)"
  npx tsx scripts/ingest-release-notes.ts --release "$RELEASE" --number "$NUMBER" \
    --out "$WORK_DIR/release-notes.csv" --raw-dir "$WORK_DIR/rn-raw/$RELEASE"
  NEW_CSVS+=("$WORK_DIR/release-notes.csv")
  MERGE_ARGS+=(--replace-source "release-notes-$RELEASE")

  HAS_SUMMARIES=$(gzip -dc db/init/seed-release-summaries.csv.gz | grep -c "^$RELEASE," || true)
  if [ "$HAS_SUMMARIES" -eq 0 ] || [ "$RESUMMARIZE" = true ]; then
    need claude
    # The previous release's summaries are the structure/tone reference (release numbers step by 2)
    read -r PREV_RELEASE _ < <(npx tsx -e "
      const n = $NUMBER - 2, k = (n - 260) / 2, s = ['spring', 'summer', 'winter'][((k % 3) + 3) % 3];
      console.log(s + '-' + (26 + Math.floor(k / 3) + (s === 'winter' ? 1 : 0)));")
    echo "Generating $RELEASE summaries (style reference: $PREV_RELEASE)"
    python3 -I scripts/generate-release-summaries.py --release "$RELEASE" \
      --chunks "$WORK_DIR/release-notes.csv" --toc "$WORK_DIR/rn-raw/$RELEASE/_toc.html" \
      --examples db/init/seed-release-summaries.csv.gz --example-release "$PREV_RELEASE" \
      --out "$WORK_DIR/release-summaries.csv" --work-dir "$WORK_DIR/summaries-work"
    MERGE_ARGS+=(--summaries "$WORK_DIR/release-summaries.csv")
  else
    echo "Seed already has $RELEASE summaries — skipping (use --resummarize to regenerate)"
  fi
fi

if has_step decision-guides; then
  echo ""
  echo "== Architect decision guides"
  npx tsx scripts/ingest-architect-decision-guides.ts --out "$WORK_DIR/decision-guides.csv" --raw-root "$WORK_DIR/dg-raw"
  NEW_CSVS+=("$WORK_DIR/decision-guides.csv")
  MERGE_ARGS+=(--replace-prefix "https://architect.salesforce.com/docs/architect/decision-guides/guide")
fi

if has_step dev-guides; then
  echo ""
  echo "== Developer guides"
  npx tsx scripts/ingest-dev-guides.ts --guide all --out-dir "$WORK_DIR" --raw-root "$WORK_DIR/devdocs-raw"
  for source in apex-dev-guide lwc-dev-guide agentforce-dev-guide agentforce-vibes-dev-guide agentforce-mobile-sdk-dev-guide; do
    NEW_CSVS+=("$WORK_DIR/devguide-$source.csv")
  done
  MERGE_ARGS+=(
    --replace-prefix "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
    --replace-prefix "https://developer.salesforce.com/docs/platform/lwc/guide/"
    --replace-prefix "https://developer.salesforce.com/docs/ai/agentforce/guide/"
    --replace-prefix "https://developer.salesforce.com/docs/platform/einstein-for-devs/guide/"
    --replace-prefix "https://developer.salesforce.com/docs/platform/agentforcevibes/guide/"
    --replace-prefix "https://developer.salesforce.com/docs/ai/agentforce-mobile-sdk/guide/"
  )
fi

if [ ${#NEW_CSVS[@]} -eq 0 ]; then
  echo "Nothing to merge (--only $STEPS)" >&2
  exit 1
fi

echo ""
echo "== Merging into db/init/"
python3 -I scripts/merge-seed.py "${NEW_CSVS[@]}" ${MERGE_ARGS[@]+"${MERGE_ARGS[@]}"}

rm -rf "$WORK_DIR"
echo ""
echo "Done. Load the new data with:"
echo "  docker compose down -v && docker compose up --build"
