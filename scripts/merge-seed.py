#!/usr/bin/env python3
"""Merges newly ingested blog/video chunks into the seed files.

  - Drops blog and YouTube chunks older than the rolling one-year window
    (same policy as export-from-production.sh)
  - Optionally drops every chunk under a URL prefix or source that is being fully re-ingested
    (e.g. architect decision guides, a release's notes)
  - Appends the new chunks produced by scripts/ingest-*.ts
  - Optionally replaces a release's rows in seed-release-summaries.csv.gz (--summaries)
  - Re-splits into parts under ~80MB uncompressed (GitHub file size limit) and gzips

Usage:
  python3 scripts/merge-seed.py /tmp/new-chunks.csv [more.csv ...] [--cutoff YYYY-MM-DD]
                                [--replace-prefix https://architect.salesforce.com/docs/architect/decision-guides/]
                                [--replace-source release-notes-winter-27]
                                [--summaries /tmp/winter27-summaries.csv]
"""

import argparse
import csv
import datetime
import glob
import gzip
import os
import sys

csv.field_size_limit(sys.maxsize)

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT_DIR, "db", "init")
MAX_BYTES = 80_000_000
SUMMARY_HEADER = ["release", "persona", "summary", "chunk_count", "model", "product"]
HEADER = ["source", "url", "heading_path", "content", "embedding", "content_hash", "published_at"]


def is_rolling(source):
    return source.endswith("-blog") or source.endswith("-youtube")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("new_chunks", nargs="+")
    one_year_ago = (datetime.date.today() - datetime.timedelta(days=365)).isoformat()
    parser.add_argument("--cutoff", default=one_year_ago, help="Drop blog/video chunks published before this date")
    parser.add_argument("--replace-prefix", action="append", default=[], help="Drop existing chunks whose URL starts with this prefix")
    parser.add_argument("--replace-source", action="append", default=[], help="Drop existing chunks with this source")
    parser.add_argument("--summaries", help="Release summaries CSV; replaces existing rows for the same release(s)")
    args = parser.parse_args()

    existing = sorted(glob.glob(os.path.join(OUT_DIR, "seed-chunks-*.csv.gz")))
    kept, dropped, replaced, added = 0, 0, 0, 0
    prefixes = tuple(args.replace_prefix)
    replace_sources = set(args.replace_source)
    part, size, writer, outfile = 0, 0, None, None
    tmp_files = []

    def write(row):
        nonlocal part, size, writer, outfile
        if writer is None or size >= MAX_BYTES:
            if outfile:
                outfile.close()
            part += 1
            name = os.path.join(OUT_DIR, f"seed-chunks-{part:02d}.csv.gz.tmp")
            tmp_files.append(name)
            outfile = gzip.open(name, "wt", newline="", encoding="utf-8")
            writer = csv.writer(outfile, lineterminator="\n")
            writer.writerow(HEADER)
            size = 0
        writer.writerow(row)
        size += sum(len(field) for field in row) + len(row)

    for path in existing:
        with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            if next(reader) != HEADER:
                sys.exit(f"Unexpected header in {path}")
            for row in reader:
                # published_at is "YYYY-MM-DD HH:MM:SS+00" so a string compare on the date prefix works
                if is_rolling(row[0]) and row[6] and row[6][:10] < args.cutoff:
                    dropped += 1
                    continue
                if row[0] in replace_sources or (prefixes and row[1].startswith(prefixes)):
                    replaced += 1
                    continue
                write(row)
                kept += 1

    for new_path in args.new_chunks:
        with open(new_path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            if next(reader) != HEADER:
                sys.exit(f"Unexpected header in {new_path}")
            for row in reader:
                write(row)
                added += 1

    if outfile:
        outfile.close()

    for path in existing:
        os.remove(path)
    for tmp in tmp_files:
        os.rename(tmp, tmp[: -len(".tmp")])

    print(f"Kept {kept}, dropped {dropped} (blog/video before {args.cutoff}), replaced {replaced}, added {added}")
    print(f"Wrote {len(tmp_files)} seed-chunks parts to {OUT_DIR}")

    if args.summaries:
        merge_summaries(args.summaries)


def merge_summaries(new_path):
    seed_path = os.path.join(OUT_DIR, "seed-release-summaries.csv.gz")
    with open(new_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        if next(reader) != SUMMARY_HEADER:
            sys.exit(f"Unexpected header in {new_path}")
        new_rows = list(reader)
    releases = {row[0] for row in new_rows}
    with gzip.open(seed_path, "rt", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        if next(reader) != SUMMARY_HEADER:
            sys.exit(f"Unexpected header in {seed_path}")
        kept = [row for row in reader if row[0] not in releases]
    with gzip.open(seed_path + ".tmp", "wt", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(SUMMARY_HEADER)
        writer.writerows(kept + new_rows)
    os.rename(seed_path + ".tmp", seed_path)
    print(f"Release summaries: kept {len(kept)}, added {len(new_rows)} ({', '.join(sorted(releases))})")


if __name__ == "__main__":
    main()
