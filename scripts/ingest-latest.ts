// Fetches blog posts and YouTube videos published since the current seed snapshot,
// chunks them the same way as the existing seed data, embeds them with the same
// BGE-Small model the server uses, and writes a CSV ready for merge-seed.py.
//
// Blogs:  WordPress RSS feeds (full content:encoded), falling back to the HTML
//         category listing when a feed page errors.
// Videos: yt-dlp channel listings + English captions (manual preferred, else auto).
//
// Usage:
//   npx tsx scripts/ingest-latest.ts [--since YYYY-MM-DD] [--out /tmp/new-chunks.csv]
//
// Requires yt-dlp on PATH for video ingestion.

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { createGunzip } from "zlib";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { createInterface } from "readline";
import { tmpdir } from "os";
import path from "path";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { embedBatch } from "../src/utils/embeddings.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SEED_DIR = path.join(ROOT, "db/init");

const MAX_CHUNK = 1500;
const MIN_CHUNK = 100;
const UA = "Mozilla/5.0 (compatible; salesforce-content-mcp-ingest)";

const BLOGS = [
  { source: "developer-blog", feed: "https://developer.salesforce.com/blogs/feed", listing: "https://developer.salesforce.com/blogs/page/" },
  { source: "admin-blog", feed: "https://admin.salesforce.com/feed", listing: "https://admin.salesforce.com/blog/page/" },
  { source: "architect-blog", feed: "https://www.salesforce.com/blog/category/architects/feed/?bc=OTH", listing: "https://www.salesforce.com/blog/category/architects/page/" },
];

const CHANNELS = [
  { source: "developer-youtube", channelId: "UCKORm8sxh3cheBpqs0akkhg" },
  { source: "architect-youtube", channelId: "UC9OaSDoddWJ7Zwu83nANsCA" },
  { source: "admin-youtube", channelId: "UCJZ40ShB_oLStzaYT4m9WWQ" },
];

// Stop paging a blog once this many consecutive pages contain nothing new
const MAX_FEED_PAGES = 40;
// How far back to list each channel when looking for the newest already-ingested video
const MAX_CHANNEL_SCAN = 200;

interface Row {
  source: string;
  url: string;
  headingPath: string;
  content: string;
  contentHash: string;
  publishedAt: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const since = new Date(arg("since") ?? new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10));
const outPath = arg("out") ?? path.join(tmpdir(), "new-chunks.csv");

// ---------------------------------------------------------------------------
// Existing seed data — so we only ingest what's new
// ---------------------------------------------------------------------------

async function loadKnown(): Promise<{ urls: Set<string>; videoIds: Set<string> }> {
  const urls = new Set<string>();
  const videoIds = new Set<string>();
  // Seed CSV rows start with `source,url,` — multi-line content fields never begin with a source name
  const rowStart = /^(developer|admin|architect)-(blog|youtube),"?([^,"]+)/;
  for (const f of readdirSync(SEED_DIR).filter((f) => /^seed-chunks-.*\.csv\.gz$/.test(f))) {
    const rl = createInterface({ input: createReadStream(path.join(SEED_DIR, f)).pipe(createGunzip()) });
    for await (const line of rl) {
      const m = rowStart.exec(line);
      if (!m) continue;
      if (m[2] === "youtube") {
        const id = /[?&]v=([\w-]{11})/.exec(m[3]);
        if (id) videoIds.add(id[1]);
      } else {
        urls.add(normalizeUrl(m[3]));
      }
    }
  }
  return { urls, videoIds };
}

function normalizeUrl(u: string): string {
  return u.replace(/[?#].*$/, "").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < MAX_CHUNK / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = MAX_CHUNK - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const clean = (s: string) => s.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").trim();

// Walks the article body, tracking the heading hierarchy, and emits one chunk per
// section (split further at MAX_CHUNK). Mirrors the "Title > H2 > H3" heading paths in the seed.
function chunkArticle(title: string, html: string): { headingPath: string; content: string }[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, img, .screen-reader-text, .sharedaddy, .jp-relatedposts").remove();
  const chunks: { headingPath: string; content: string }[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let size = 0;

  const headingPath = () => [title, ...headings.filter(Boolean)].join(" > ");
  const flush = () => {
    const text = clean(lines.join("\n"));
    lines = [];
    size = 0;
    for (const part of splitLong(text)) {
      if (part.length >= MIN_CHUNK) chunks.push({ headingPath: headingPath(), content: part });
    }
  };
  const add = (text: string) => {
    const t = clean(text);
    if (!t) return;
    if (size + t.length + 1 > MAX_CHUNK && size > 0) flush();
    lines.push(t);
    size += t.length + 1;
  };

  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        add($(node).text());
        continue;
      }
      if (node.type !== "tag") continue;
      const el = $(node);
      const tag = node.name.toLowerCase();
      const level = /^h([1-6])$/.exec(tag);
      if (level) {
        flush();
        const depth = Math.max(0, Number(level[1]) - 2);
        headings.length = depth;
        headings[depth] = clean(el.text());
      } else if (tag === "ul" || tag === "ol") {
        el.children("li").each((_, li) => add($(li).text()));
      } else if (tag === "pre" || tag === "p" || tag === "blockquote" || tag === "figcaption") {
        add(el.text());
      } else if (tag === "table") {
        el.find("tr").each((_, tr) => add($(tr).find("th, td").map((_, c) => clean($(c).text())).get().join(" | ")));
      } else {
        walk(el.contents().toArray());
      }
    }
  };

  walk($("body").contents().toArray());
  flush();
  return chunks;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Postgres timestamptz text, matching the seed's "2026-04-02 14:00:13+00"
const pgTime = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");

// ---------------------------------------------------------------------------
// Blogs
// ---------------------------------------------------------------------------

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return null;
}

interface Post { url: string; title: string; publishedAt: Date; html: string }

function parseFeed(xml: string): Post[] {
  const $ = cheerio.load(xml, { xml: true });
  return $("item").toArray().map((item) => {
    const el = $(item);
    return {
      url: el.find("link").first().text().trim(),
      title: clean(el.find("title").first().text()),
      publishedAt: new Date(el.find("pubDate").first().text()),
      html: el.find("content\\:encoded").first().text(),
    };
  });
}

// Fallback for feed pages that error: list post URLs from the HTML archive, then scrape each post
async function scrapeListingPage(listingBase: string, page: number): Promise<Post[]> {
  const html = await fetchText(`${listingBase}${page}/`);
  if (!html) return [];
  const $ = cheerio.load(html);
  const origin = new URL(listingBase).origin;
  const links = new Set<string>();
  $("article a[href], h2 a[href], h3 a[href]").each((_, a) => {
    const href = new URL($(a).attr("href")!, origin).href;
    // Posts are /blog/<slug>/ or /blogs/<yyyy>/<mm>/<slug> — nested paths are other sections (e.g. /blog/small-business/...)
    if (/\/blogs?\/(\d{4}\/\d{2}\/)?[\w-]+\/?$/.test(href) && !/\/(category|tag|author|page|feed)\/?$/.test(href)) links.add(href);
  });
  const posts: Post[] = [];
  for (const link of links) {
    const page = await fetchText(link);
    if (!page) continue;
    const $p = cheerio.load(page);
    const published = $p('meta[property="article:published_time"]').attr("content");
    const body = $p(".post__content, .entry-content, .post-content").first();
    if (!published || !body.length) continue;
    posts.push({
      url: link,
      title: clean($p('meta[property="og:title"]').attr("content") ?? $p("h1").first().text()),
      publishedAt: new Date(published),
      html: body.html() ?? "",
    });
  }
  return posts;
}

async function ingestBlogs(knownUrls: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const blog of BLOGS) {
    const seen = new Set<string>();
    let added = 0;
    for (let page = 1; page <= MAX_FEED_PAGES; page++) {
      const sep = blog.feed.includes("?") ? "&" : "?";
      const xml = await fetchText(page === 1 ? blog.feed : `${blog.feed}${sep}paged=${page}`);
      let posts = xml ? parseFeed(xml) : [];
      if (posts.length === 0) {
        console.error(`  ${blog.source}: feed page ${page} failed, scraping HTML listing`);
        posts = await scrapeListingPage(blog.listing, page);
        if (posts.length === 0) break;
      }
      for (const post of posts) {
        const key = normalizeUrl(post.url);
        if (seen.has(key) || knownUrls.has(key) || post.publishedAt < since) continue;
        seen.add(key);
        const chunks = chunkArticle(post.title, post.html);
        const hash = sha256(chunks.map((c) => c.content).join("\n"));
        for (const c of chunks) {
          rows.push({ source: blog.source, url: post.url, headingPath: c.headingPath, content: c.content, contentHash: hash, publishedAt: pgTime(post.publishedAt) });
        }
        added++;
      }
      if (posts.every((p) => p.publishedAt < since)) break;
    }
    console.error(`  ${blog.source}: ${added} new posts`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

function ytdlp(args: string[]): string {
  return execFileSync("yt-dlp", ["--no-warnings", "--ignore-errors", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

interface Caption { start: number; text: string }

function readJson3(file: string): Caption[] {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const caps: Caption[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s: { utf8: string }) => s.utf8).join("").replace(/\s+/g, " ").trim();
    if (text) caps.push({ start: Math.floor((ev.tStartMs ?? 0) / 1000), text });
  }
  return caps;
}

const timestamp = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function chunkTranscript(caps: Caption[]): { start: number; content: string }[] {
  const chunks: { start: number; content: string }[] = [];
  let buf: string[] = [];
  let start = 0;
  let size = 0;
  const flush = () => {
    const content = buf.join(" ").trim();
    if (content.length >= MIN_CHUNK || (chunks.length === 0 && content)) chunks.push({ start, content });
    buf = [];
    size = 0;
  };
  for (const cap of caps) {
    if (size > 0 && size + cap.text.length + 1 > MAX_CHUNK) flush();
    if (size === 0) start = cap.start;
    for (const piece of splitLong(cap.text)) {
      buf.push(piece);
      size += piece.length + 1;
    }
  }
  if (size > 0) flush();
  return chunks;
}

async function ingestVideos(knownIds: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  const workDir = mkdtempSync(path.join(tmpdir(), "yt-ingest-"));
  try {
    for (const ch of CHANNELS) {
      // Channel /videos tab is newest-first; everything before the first known id is new
      const listing = ytdlp(["--flat-playlist", "--playlist-end", String(MAX_CHANNEL_SCAN), "--print", "%(id)s", `https://www.youtube.com/channel/${ch.channelId}/videos`]);
      const ids: string[] = [];
      for (const id of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (knownIds.has(id)) break;
        ids.push(id);
      }

      let added = 0;
      for (const id of ids) {
        const dir = path.join(workDir, id);
        ytdlp(["--skip-download", "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-US,en-GB,en-orig", "--sub-format", "json3", "--sleep-requests", "1", "-o", path.join(dir, "%(id)s.%(ext)s"), `https://www.youtube.com/watch?v=${id}`]);
        const infoFile = path.join(dir, `${id}.info.json`);
        if (!existsSync(infoFile)) continue;
        const info = JSON.parse(readFileSync(infoFile, "utf8"));
        const published = info.timestamp ? new Date(info.timestamp * 1000) : new Date(`${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}T00:00:00Z`);
        if (published < since || info.live_status === "is_upcoming") continue;

        // Manual English captions beat auto-generated; en-orig is the untranslated ASR track
        const subFiles = readdirSync(dir).filter((f) => f.endsWith(".json3"));
        const pick = ["en", "en-US", "en-GB", "en-orig"].map((l) => `${id}.${l}.json3`).find((f) => subFiles.includes(f));
        if (!pick) {
          console.error(`    skip ${id} (no English captions): ${info.title}`);
          continue;
        }
        const caps = readJson3(path.join(dir, pick));
        const chunks = chunkTranscript(caps);
        if (chunks.length === 0) continue;
        const hash = sha256(caps.map((c) => c.text).join(" "));
        for (const c of chunks) {
          rows.push({
            source: ch.source,
            url: `https://www.youtube.com/watch?v=${id}&t=${c.start}`,
            headingPath: `${clean(info.title)} > ${timestamp(c.start)}`,
            content: c.content,
            contentHash: hash,
            publishedAt: pgTime(published),
          });
        }
        added++;
      }
      console.error(`  ${ch.source}: ${added} new videos (${ids.length} listed since last snapshot)`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function main() {
  console.error(`Ingesting blogs and videos published since ${since.toISOString().slice(0, 10)}`);
  console.error("Loading existing seed URLs...");
  const known = await loadKnown();
  console.error(`  ${known.urls.size} blog posts, ${known.videoIds.size} videos already in seed`);

  console.error("Blogs:");
  const blogRows = await ingestBlogs(known.urls);
  console.error("Videos:");
  const videoRows = await ingestVideos(known.videoIds);
  const rows = [...blogRows, ...videoRows];

  console.error(`Embedding ${rows.length} chunks...`);
  const out = createWriteStream(outPath);
  out.write("source,url,heading_path,content,embedding,content_hash,published_at\n");
  const BATCH = 64;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // The seed embeds "heading_path\ncontent" — verified against stored vectors
    const vectors = await embedBatch(batch.map((r) => `${r.headingPath}\n${r.content}`));
    batch.forEach((r, j) => {
      const embedding = `[${vectors[j].join(",")}]`;
      out.write([r.source, r.url, r.headingPath, r.content, embedding, r.contentHash, r.publishedAt].map(csvField).join(",") + "\n");
    });
    if ((i / BATCH) % 10 === 0) console.error(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  await new Promise<void>((resolve) => out.end(resolve));
  console.error(`Wrote ${rows.length} chunks to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
