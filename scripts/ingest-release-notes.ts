// Fetches a full Salesforce release-notes release from help.salesforce.com, chunks each
// page the same way as the existing release-notes seed data, embeds the chunks with the
// same BGE-Small model the server uses, and writes a CSV ready for merge-seed.py.
//
// help.salesforce.com is a Lightning (Aura) site; the article view loads its content from
// the guest-accessible Apex action Help_ArticleDataController.getData. That response
// carries the page HTML (DITA output) plus the full release table of contents, which we
// use as the page list. Raw page HTML is cached in --raw-dir so re-runs resume.
//
// Usage:
//   npx tsx scripts/ingest-release-notes.ts --release winter-27 --number 264 \
//     [--published-at 2026-10-01] [--out /tmp/release-chunks.csv] [--raw-dir /tmp/rn-raw/winter-27] \
//     [--concurrency 3] [--delay 500] [--limit N]
//   npx tsx scripts/ingest-release-notes.ts --print-latest   # prints e.g. "winter-27 264"

import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { embedBatch } from "../src/utils/embeddings.js";

const MAX_CHUNK = 1500;
const MIN_CHUNK = 100;
const UA = "Mozilla/5.0 (compatible; salesforce-content-mcp-ingest)";
const HELP = "https://help.salesforce.com";
const ROOT_TOPIC = "salesforce_release_notes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const printLatest = process.argv.includes("--print-latest");
const release = printLatest ? "winter-00" : arg("release"); // e.g. winter-27
const number = printLatest ? "000" : arg("number"); // e.g. 264
if (!release || !/^(spring|summer|winter)-\d{2}$/.test(release) || !number || !/^\d{3}$/.test(number)) {
  console.error("Usage: --release <spring|summer|winter>-<yy> --number <NNN> [--published-at YYYY-MM-DD] [--out file] [--raw-dir dir]");
  process.exit(1);
}
const [season, yy] = release.split("-");
const label = `${season[0].toUpperCase()}${season.slice(1)} '${yy}`; // Winter '27
const version = `${number}.0.0`;
const source = `release-notes-${release}`;

// Nominal release date: Spring = Feb of its year, Summer = Jun, Winter = Oct of the previous year
function defaultPublished(): string {
  const year = 2000 + Number(yy);
  if (season === "spring") return `${year}-02-01`;
  if (season === "summer") return `${year}-06-01`;
  return `${year - 1}-10-01`;
}
const publishedAt = new Date(`${arg("published-at") ?? defaultPublished()}T00:00:00Z`);
const outPath = arg("out") ?? path.join(tmpdir(), "release-chunks.csv");
const rawDir = arg("raw-dir") ?? path.join(tmpdir(), "rn-raw", release);
const concurrency = Number(arg("concurrency") ?? 3);
const delayMs = Number(arg("delay") ?? 500);
const limit = arg("limit") ? Number(arg("limit")) : Infinity;

interface Row {
  source: string;
  url: string;
  headingPath: string;
  content: string;
  contentHash: string;
  publishedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Postgres timestamptz text, matching the seed's "2026-06-01 00:00:00+00"
const pgTime = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "+00");
const articleUrl = (topic: string) => `${HELP}/s/articleView?id=release-notes.${topic}.htm&release=${number}&type=5`;

// ---------------------------------------------------------------------------
// Aura transport
// ---------------------------------------------------------------------------

interface AuraContext { fwuid: string; loaded: Record<string, string> }

// The fwuid / app hash change with every site deploy, so read them from the live page
async function loadAuraContext(): Promise<AuraContext> {
  const res = await fetch(articleUrl(ROOT_TOPIC), { headers: { "User-Agent": UA } });
  const html = await res.text();
  for (const m of html.matchAll(/\/s\/sfsites\/l\/([^"/]+)/g)) {
    try {
      const ctx = JSON.parse(decodeURIComponent(m[1]));
      if (ctx.fwuid && ctx.loaded) return { fwuid: ctx.fwuid, loaded: ctx.loaded };
    } catch {}
  }
  throw new Error("Could not find Aura fwuid on help.salesforce.com article page");
}

interface Page { topic: string; title: string; version: string; published: string; html: string }

async function getData(ctx: AuraContext, topic: string): Promise<any> {
  const message = {
    actions: [{
      id: "1;a",
      descriptor: "aura://ApexActionController/ACTION$execute",
      callingDescriptor: "UNKNOWN",
      params: {
        namespace: "",
        classname: "Help_ArticleDataController",
        method: "getData",
        params: { articleParameters: { urlName: `release-notes.${topic}.htm`, language: "en_US", release: version, requestedArticleType: "HelpDocs", requestedArticleTypeNumber: "5" } },
        cacheable: false,
        isContinuation: false,
      },
    }],
  };
  const context = { mode: "PROD", fwuid: ctx.fwuid, app: "siteforce:communityApp", loaded: ctx.loaded, dn: [], globals: {}, uad: false };
  const body = new URLSearchParams({ message: JSON.stringify(message), "aura.context": JSON.stringify(context), "aura.pageURI": "/s/articleView", "aura.token": "null" });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${HELP}/s/sfsites/aura?r=1&aura.ApexAction.execute=1`, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) {
        const action = (await res.json()).actions?.[0];
        if (action?.state === "SUCCESS") return action.returnValue?.returnValue ?? null;
        console.error(`    ${topic}: aura state ${action?.state} ${JSON.stringify(action?.error ?? "").slice(0, 200)}`);
      } else {
        console.error(`    ${topic}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`    ${topic}: ${(err as Error).message}`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

// Fetches one page, caching only the article HTML + metadata (the ~1.5 MB TOC is dropped)
async function fetchPage(ctx: AuraContext, topic: string): Promise<Page | null> {
  const file = path.join(rawDir, `${topic}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const rv = await getData(ctx, topic);
  const rec = rv?.record;
  if (!rec?.Content__c || rec.Is_Error_Response__c) return null;
  const page: Page = { topic, title: rec.Title__c ?? "", version: rec.Version__c ?? "", published: rec.Published_Date__c ?? "", html: rec.Content__c };
  writeFileSync(file, JSON.stringify(page));
  return page;
}

interface TocEntry { topic: string; level: number; title: string }

async function fetchToc(ctx: AuraContext): Promise<TocEntry[]> {
  const file = path.join(rawDir, "_toc.html");
  let toc: string;
  if (existsSync(file)) {
    toc = readFileSync(file, "utf8");
  } else {
    const rv = await getData(ctx, ROOT_TOPIC);
    if (rv?.record?.Version__c !== version) throw new Error(`Release ${version} not available (latest is ${rv?.latestRNVersion})`);
    const t = rv.tableOfContent;
    // Large TOCs come back split across Help_Docs_Cache_Details__r parts
    toc = t?.Help_Docs_Cache_Details__r?.length ? t.Help_Docs_Cache_Details__r.map((p: { Content__c: string }) => p.Content__c).join("") : t?.Content__c ?? "";
    writeFileSync(file, toc);
  }
  const $ = cheerio.load(toc.replace(/^\./, "").replace(/\.$/, ""));
  const entries: TocEntry[] = [];
  const seen = new Set<string>();
  $("li[role=treeitem]").each((_, li) => {
    const a = $(li).children(".slds-tree__item").find("a[href]").first();
    const m = /id=release-notes\.([\w.-]+?)\.htm/.exec(a.attr("href") ?? "");
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    entries.push({ topic: m[1], level: Number($(li).attr("aria-level") ?? 0), title: inline(a.text()) });
  });
  return entries;
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

// DITA output hard-wraps source lines; collapse all whitespace, keeping <br> as newlines
const BR = "\uE000";
const inline = (s: string) => s.replace(/\s+/g, " ").trim().replace(new RegExp(` ?${BR} ?`, "g"), "\n").replace(/\n{2,}/g, "\n").trim();

const BLOCKS = "p, div, ul, ol, li, table, tr, pre, blockquote, dl, dt, dd, h1, h2, h3, h4, h5, h6, section, figure, figcaption";

// Walks the article body, tracking the heading hierarchy, and emits one chunk per section
// (split further at MAX_CHUNK). Heading paths are "<Release> Release Notes > Page Title > H2 > H3".
function chunkPage(html: string, fallbackTitle: string): { title: string; text: string; chunks: { headingPath: string; content: string }[] } {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, img, .slds-breadcrumb, #bread-crumb-label").remove();
  $("br").replaceWith(BR);
  const root = $("#content").length ? $("#content") : $("body");
  const title = inline(root.find("h1").first().text()) || inline(fallbackTitle);
  root.find("h1").first().remove();

  const chunks: { headingPath: string; content: string }[] = [];
  const all: string[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let size = 0;

  const headingPath = () => [`${label} Release Notes`, title, ...headings.filter(Boolean)].join(" > ");
  const flush = () => {
    const text = lines.join("\n").trim();
    lines = [];
    size = 0;
    for (const part of splitLong(text)) {
      if (part.length >= MIN_CHUNK) chunks.push({ headingPath: headingPath(), content: part });
    }
  };
  const add = (text: string) => {
    const t = inline(text);
    if (!t) return;
    all.push(t);
    if (size + t.length + 1 > MAX_CHUNK && size > 0) flush();
    lines.push(t);
    size += t.length + 1;
  };
  const cellText = (cell: AnyNode) => {
    const el = $(cell);
    const items = el.find("li");
    return items.length ? items.map((_, li) => inline($(li).text())).get().join("; ") : inline(el.text());
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
        headings[depth] = inline(el.text());
      } else if (tag === "table") {
        el.find("tr").each((_, tr) => add($(tr).children("th, td").map((_, c) => cellText(c)).get().join(" | ")));
      } else if (tag === "li") {
        // An item's own text first, then any nested lists as their own lines
        const own = el.clone();
        own.find("ul, ol").remove();
        add(own.text());
        el.find("> ul, > ol").each((_, l) => walk([l]));
      } else if (tag === "pre" || el.find(BLOCKS).length === 0) {
        add(el.text());
      } else {
        walk(el.contents().toArray());
      }
    }
  };

  walk(root.contents().toArray());
  flush();
  return { title, text: [title, ...all].join("\n"), chunks };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Release numbers step by 2 per release: 260 = Spring '26, 262 = Summer '26, 264 = Winter '27
function releaseName(num: number): string {
  const k = (num - 260) / 2;
  const season = ["spring", "summer", "winter"][((k % 3) + 3) % 3];
  const yy = 26 + Math.floor(k / 3) + (season === "winter" ? 1 : 0);
  return `${season}-${yy}`;
}

async function main() {
  if (printLatest) {
    const rv = await getData(await loadAuraContext(), ROOT_TOPIC);
    const latest = parseInt(rv?.latestRNVersion ?? "", 10);
    if (!latest) throw new Error("Could not determine the latest release");
    console.log(`${releaseName(latest)} ${latest}`);
    return;
  }
  mkdirSync(rawDir, { recursive: true });
  console.error(`Ingesting ${label} release notes (release ${number}) as ${source}`);
  const ctx = await loadAuraContext();
  const toc = (await fetchToc(ctx)).slice(0, limit);
  console.error(`  ${toc.length} pages in table of contents`);

  // Fetch with a small worker pool and a delay between each worker's requests
  const pages = new Map<string, Page>();
  const failed: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < toc.length) {
      const entry = toc[next++];
      const cached = existsSync(path.join(rawDir, `${entry.topic}.json`));
      const page = await fetchPage(ctx, entry.topic);
      if (!page) failed.push(entry.topic);
      else if (page.version !== version) console.error(`    skip ${entry.topic}: served version ${page.version}`);
      else pages.set(entry.topic, page);
      if (++done % 100 === 0) console.error(`  fetched ${done}/${toc.length}`);
      if (!cached) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.error(`  ${pages.size} pages fetched, ${failed.length} failed${failed.length ? `: ${failed.join(", ")}` : ""}`);

  const rows: Row[] = [];
  const seen = new Set<string>();
  let empty = 0;
  for (const entry of toc) {
    const page = pages.get(entry.topic);
    if (!page) continue;
    const { text, chunks } = chunkPage(page.html, page.title || entry.title);
    if (chunks.length === 0) empty++;
    const hash = sha256(text);
    const url = articleUrl(entry.topic);
    for (const c of chunks) {
      const key = `${url}\u0000${c.headingPath}\u0000${c.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ source, url, headingPath: c.headingPath, content: c.content, contentHash: hash, publishedAt: pgTime(publishedAt) });
    }
  }
  console.error(`  ${rows.length} chunks from ${pages.size - empty} pages (${empty} pages had no chunk >= ${MIN_CHUNK} chars)`);

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
