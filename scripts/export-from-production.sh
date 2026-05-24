#!/bin/bash
# Exports data from the production database into compressed CSVs that auto-load
# when the Docker postgres container first starts.
#
# Includes:
#   - ALL dev guide chunks (source LIKE '%-dev-guide')
#   - ALL mulesoft chunks
#   - ALL marketing cloud chunks
#   - ALL architect content
#   - Release notes
#   - Blogs and videos from the last year
#   - All code samples
#   - All release summaries
#
# Usage:
#   DATABASE_URL=$(heroku config:get DATABASE_URL) ./scripts/export-from-production.sh
#
# Output: db/init/seed-*.csv.gz (split into <100MB files for GitHub)

set -euo pipefail

DB_URL="${DATABASE_URL:?Set DATABASE_URL to the source database}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT_DIR/db/init"

mkdir -p "$OUT_DIR"

ONE_YEAR_AGO=$(date -v-1y +%Y-%m-%d 2>/dev/null || date -d "1 year ago" +%Y-%m-%d)

echo "Exporting from production..."
echo "  Blog/video cutoff: $ONE_YEAR_AGO"
echo ""

echo "Exporting chunks..."
CHUNK_COUNT=$(psql "$DB_URL" -t -c "
  SELECT count(*) FROM chunks
  WHERE source LIKE '%-dev-guide'
    OR source LIKE 'mulesoft%'
    OR source LIKE 'marketing-cloud%'
    OR source LIKE 'salesforce-personalization%'
    OR source LIKE 'release-notes%'
    OR source = 'architect'
    OR (source LIKE '%-blog' AND published_at >= '$ONE_YEAR_AGO')
    OR (source LIKE '%-youtube' AND published_at >= '$ONE_YEAR_AGO')
")
echo "  Chunks to export: $(echo $CHUNK_COUNT | tr -d ' ')"

psql "$DB_URL" -c "
  COPY (
    SELECT source, url, heading_path, content, embedding, content_hash, published_at
    FROM chunks
    WHERE source LIKE '%-dev-guide'
      OR source LIKE 'mulesoft%'
      OR source LIKE 'marketing-cloud%'
      OR source LIKE 'salesforce-personalization%'
      OR source LIKE 'release-notes%'
      OR source = 'architect'
      OR (source LIKE '%-blog' AND published_at >= '$ONE_YEAR_AGO')
      OR (source LIKE '%-youtube' AND published_at >= '$ONE_YEAR_AGO')
  ) TO STDOUT WITH (FORMAT csv, HEADER true)
" > /tmp/seed-chunks.csv

echo "Exporting code samples..."
psql "$DB_URL" -c "
  COPY (
    SELECT repo, org, file_path, url, language, component_type, content, heading_path, embedding, content_hash, api_names
    FROM code_samples
  ) TO STDOUT WITH (FORMAT csv, HEADER true)
" > /tmp/seed-code-samples.csv

echo "Exporting release summaries..."
psql "$DB_URL" -c "
  COPY (
    SELECT release, persona, summary, chunk_count, model, product
    FROM release_summaries
  ) TO STDOUT WITH (FORMAT csv, HEADER true)
" > /tmp/seed-release-summaries.csv

# Split chunks CSV into parts under 100MB (for GitHub file size limits)
echo "Splitting chunks into parts..."
rm -f "$OUT_DIR"/seed-chunks-*.csv.gz

python3 -c "
import csv, os

input_file = '/tmp/seed-chunks.csv'
out_dir = '$OUT_DIR'
max_bytes = 80_000_000  # ~80MB uncompressed per part

with open(input_file, 'r', newline='') as f:
    reader = csv.reader(f)
    header = next(reader)
    part = 1
    current_size = 0
    writer = None
    outfile = None

    for row in reader:
        if writer is None or current_size >= max_bytes:
            if outfile:
                outfile.close()
            fname = os.path.join(out_dir, f'seed-chunks-{part:02d}.csv')
            outfile = open(fname, 'w', newline='')
            writer = csv.writer(outfile)
            writer.writerow(header)
            current_size = 0
            part += 1

        writer.writerow(row)
        current_size += sum(len(field) for field in row) + len(row)

    if outfile:
        outfile.close()

print(f'  Split into {part - 1} parts')
"

# Compress all seed files
echo "Compressing..."
for f in "$OUT_DIR"/seed-chunks-*.csv; do
  gzip -f "$f"
done
gzip -f /tmp/seed-code-samples.csv && mv /tmp/seed-code-samples.csv.gz "$OUT_DIR/"
gzip -f /tmp/seed-release-summaries.csv && mv /tmp/seed-release-summaries.csv.gz "$OUT_DIR/"

rm -f /tmp/seed-chunks.csv

echo ""
echo "Done! Files written to db/init/:"
ls -lh "$OUT_DIR"
echo ""
echo "Users just run: docker compose up"
