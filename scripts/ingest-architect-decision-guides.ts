// Re-ingests the Salesforce Architects decision guides
// (https://architect.salesforce.com/docs/architect/decision-guides/guide) as a FULL
// replacement for every seed row under that URL prefix.
//
// Discovery: the docs app server-renders each page; the guide's table of contents is
// embedded in the `sidebar-content` attribute of <doc-content-layout> (JSON). We take
// every link in that tree, plus the guide index page itself, and cross-check against
// sitemap-1.xml so guides missing from the sidebar are still picked up.
//
// Content: the article body is the server-rendered HTML inside <doc-content-layout>.
// Section headings are <doc-heading header="..." aria-level="N"> custom elements; the
// page title is the <h1>. Chunks get heading paths "Page Title > H2 > H3 > H4".
//
// Usage:
//   npx tsx scripts/ingest-architect-decision-guides.ts [--out /tmp/sfada/architect-dg-chunks.csv] [--raw-root /tmp/sfada/dg-raw]
//
// Raw HTML downloads go to a fresh, empty directory under --raw-root.

import { createHash } from "crypto";
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import path from "path";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { embedBatch } from "../src/utils/embeddings.js";

const MAX_CHUNK = 1500;
const MIN_CHUNK = 100;
const UA = "Mozilla/5.0 (compatible; salesforce-content-mcp-ingest)";

const SOURCE = "architect";
const ORIGIN = "https://architect.salesforce.com";
const PREFIX = `${ORIGIN}/docs/architect/decision-guides/guide`;
const SITEMAP = `${ORIGIN}/sitemap-1.xml`;

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

const outPath = arg("out") ?? "/tmp/sfada/architect-dg-chunks.csv";
const rawRoot = arg("raw-root") ?? "/tmp/sfada/dg-raw";

// ---------------------------------------------------------------------------
// Fetching
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

// Seed URL scheme: the index is ".../guide" (no trailing slash), pages are ".../guide/<slug>.html"
function canonicalUrl(href: string): string {
  const u = new URL(href, ORIGIN).href.replace(/[?#].*$/, "").replace(/\/$/, "");
  if (u === PREFIX || u === PREFIX.replace(/\/guide$/, "")) return PREFIX;
  return /\.html$/.test(u) ? u : `${u}.html`;
}

interface SidebarNode { label: string; name: string; link?: { href: string }; children?: SidebarNode[] }

function sidebarUrls(html: string): string[] {
  const $ = cheerio.load(html);
  const raw = $("doc-content-layout").attr("sidebar-content");
  if (!raw) return [];
  const urls: string[] = [];
  const walk = (nodes: SidebarNode[]) => {
    for (const n of nodes) {
      const href = n.link?.href ?? n.name;
      if (href) urls.push(canonicalUrl(href));
      walk(n.children ?? []);
    }
  };
  walk(JSON.parse(raw));
  return urls;
}

async function discover(): Promise<string[]> {
  const index = await fetchText(PREFIX);
  if (!index) throw new Error(`Could not fetch guide index ${PREFIX}`);
  const urls = new Set<string>([PREFIX, ...sidebarUrls(index)]);
  const sitemap = await fetchText(SITEMAP);
  if (sitemap) {
    // English pages only (localized copies live under /docs/architect/<locale>/...)
    for (const m of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (m[1].startsWith(`${PREFIX}/`) || m[1] === PREFIX) {
        const u = canonicalUrl(m[1]);
        if (!urls.has(u)) console.error(`  sitemap-only page: ${u}`);
        urls.add(u);
      }
    }
  } else {
    console.error("  warning: sitemap unavailable, using sidebar only");
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// Chunking (same splitting rules as ingest-latest.ts)
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

interface Page { title: string; chunks: { headingPath: string; content: string }[]; text: string }

// Walks the <doc-content-layout> body, tracking <doc-heading> levels, emitting one chunk
// per section (split further at MAX_CHUNK). Also returns the full page text for hashing.
function chunkGuide(html: string): Page | null {
  const $ = cheerio.load(html);
  const layout = $("doc-content-layout").first();
  if (!layout.length) return null;
  layout.find("script, style, noscript, iframe, svg, img").remove();
  // Link lists and table cells use <br> as a separator; .text() would glue the lines together
  layout.find("br").replaceWith("\n");
  const title = clean(layout.find("h1").first().text());
  const chunks: { headingPath: string; content: string }[] = [];
  const allText: string[] = [];
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
    allText.push(t);
    if (size + t.length + 1 > MAX_CHUNK && size > 0) flush();
    lines.push(t);
    size += t.length + 1;
  };
  const setHeading = (level: number, text: string) => {
    flush();
    const depth = Math.max(0, level - 2);
    headings.length = depth;
    headings[depth] = clean(text);
    allText.push(clean(text));
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
      if (tag === "h1") {
        allText.push(title);
      } else if (tag === "doc-heading") {
        setHeading(Number(el.attr("aria-level") ?? 2), el.attr("header") ?? el.text());
      } else if (level) {
        setHeading(Number(level[1]), el.text());
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

  walk(layout.contents().toArray());
  flush();
  return { title, chunks, text: allText.join("\n") };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function main() {
  mkdirSync(rawRoot, { recursive: true });
  const rawDir = mkdtempSync(path.join(rawRoot, "pages-"));
  console.error(`Raw downloads: ${rawDir}`);

  console.error("Discovering decision guides...");
  const urls = await discover();
  console.error(`  ${urls.length} pages`);

  const rows: Row[] = [];
  const failed: string[] = [];
  const manifest: { url: string; title: string; chunks: number; contentHash: string; file: string }[] = [];
  for (const url of urls) {
    const html = await fetchText(url);
    const page = html ? chunkGuide(html) : null;
    if (!html || !page || page.chunks.length === 0) {
      console.error(`  FAILED ${url}`);
      failed.push(url);
      continue;
    }
    const file = (url === PREFIX ? "index" : path.basename(url, ".html")) + ".html";
    writeFileSync(path.join(rawDir, file), html);
    const hash = sha256(page.text);
    for (const c of page.chunks) {
      rows.push({ source: SOURCE, url, headingPath: c.headingPath, content: c.content, contentHash: hash, publishedAt: "" });
    }
    manifest.push({ url, title: page.title, chunks: page.chunks.length, contentHash: hash, file });
    writeFileSync(path.join(rawDir, file.replace(/\.html$/, ".txt")), page.text);
    console.error(`  ${page.chunks.length.toString().padStart(3)} chunks  ${url}  (${page.title})`);
  }
  writeFileSync(path.join(rawDir, "manifest.json"), JSON.stringify({ failed, pages: manifest }, null, 2));

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
    console.error(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  await new Promise<void>((resolve) => out.end(resolve));
  console.error(`Wrote ${rows.length} chunks for ${manifest.length} pages to ${outPath}`);
  if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
