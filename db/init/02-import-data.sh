#!/bin/bash
set -e

echo "Decompressing seed data..."

for f in /docker-entrypoint-initdb.d/seed-chunks-*.csv.gz; do
  gunzip -k "$f"
done
gunzip -k /docker-entrypoint-initdb.d/seed-code-samples.csv.gz
gunzip -k /docker-entrypoint-initdb.d/seed-release-summaries.csv.gz

echo "Importing chunks..."
for f in /docker-entrypoint-initdb.d/seed-chunks-*.csv; do
  echo "  Loading $(basename $f)..."
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\COPY chunks(source, url, heading_path, content, embedding, content_hash, published_at) FROM '$f' WITH (FORMAT csv, HEADER true)"
done

echo "Importing code samples..."
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\COPY code_samples(repo, org, file_path, url, language, component_type, content, heading_path, embedding, content_hash, api_names) FROM '/docker-entrypoint-initdb.d/seed-code-samples.csv' WITH (FORMAT csv, HEADER true)"

echo "Importing release summaries..."
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\COPY release_summaries(release, persona, summary, chunk_count, model, product) FROM '/docker-entrypoint-initdb.d/seed-release-summaries.csv' WITH (FORMAT csv, HEADER true)"

rm /docker-entrypoint-initdb.d/seed-*.csv

echo "Seed import complete!"
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT source, count(*) FROM chunks GROUP BY source ORDER BY count DESC;"
