// Fully re-ingests Salesforce developer guides as replacement CSVs (one per guide), for
// merge-seed.py --replace-prefix. Same chunking rules as ingest-architect-decision-guides.ts,
// but with a block-aware walker so intros, notes, lists, code and tables are all kept.
//
// Guides come in two flavours:
//   atlas — developer.salesforce.com/docs/atlas.en-us.<deliverable>.meta (Apex). TOC from
//           /docs/get_document/<meta> (JSON `toc`), page HTML from
//           /docs/get_document_content/<deliverable>/<page>/en-us/<version> (JSON `content`).
//           Headings are h1/h2/h3 (helpHead classes); "← Previous / Next →" pagination stripped.
//   dsc   — developer.salesforce.com/docs/<area>/<guide>/guide (LWC, Agentforce, ...). Pages are
//           server-rendered; the TOC is the `sidebar-content` JSON on <doc-content-layout>,
//           headings are <doc-heading>, code is in <dx-code-block code-block="...">.
//
// Usage:
//   npx tsx scripts/ingest-dev-guides.ts --guide apex|lwc|agentforce|vibes|mobile-sdk|all
//        [--out-dir /tmp/sfada] [--raw-root /tmp/sfada/devdocs-raw] [--from-raw <dir>] [--no-embed]
//   --no-embed writes <csv>.preview.jsonl (rows without embeddings) for inspecting the chunker.
//
// Raw downloads go to a fresh, empty directory under --raw-root (one subdir per guide).
// --from-raw re-chunks a previous run's downloads without refetching.

import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { embedBatch } from "../src/utils/embeddings.js";

const MAX_CHUNK = 1500;
const MIN_CHUNK = 100;
const UA = "Mozilla/5.0 (compatible; salesforce-content-mcp-ingest)";
const DSC = "https://developer.salesforce.com";
const DELAY_MS = 400;

interface Guide {
  key: string;
  source: string;
  kind: "atlas" | "dsc";
  prefix: string; // every chunk URL starts with this; also the --replace-prefix value
  start: string; // TOC page (dsc) or get_document URL (atlas)
  // atlas only
  deliverable?: string;
  version?: string; // fallback only — the current doc_version from the TOC response wins
  includeRoot?: boolean; // the seed has a row for the bare guide root URL
}

const GUIDES: Guide[] = [
  {
    key: "apex",
    source: "apex-dev-guide",
    kind: "atlas",
    prefix: `${DSC}/docs/atlas.en-us.apexcode.meta/apexcode/`,
    start: `${DSC}/docs/get_document/atlas.en-us.apexcode.meta`,
    deliverable: "apexcode",
    version: "264.0",
    includeRoot: true,
  },
  { key: "lwc", source: "lwc-dev-guide", kind: "dsc", prefix: `${DSC}/docs/platform/lwc/guide/`, start: `${DSC}/docs/platform/lwc/guide` },
  { key: "agentforce", source: "agentforce-dev-guide", kind: "dsc", prefix: `${DSC}/docs/ai/agentforce/guide/`, start: `${DSC}/docs/ai/agentforce/guide` },
  {
    key: "vibes",
    source: "agentforce-vibes-dev-guide",
    kind: "dsc",
    prefix: `${DSC}/docs/platform/agentforcevibes/guide/`,
    start: `${DSC}/docs/platform/agentforcevibes/guide/afv-overview.html`,
  },
  {
    key: "mobile-sdk",
    source: "agentforce-mobile-sdk-dev-guide",
    kind: "dsc",
    prefix: `${DSC}/docs/ai/agentforce-mobile-sdk/guide/`,
    start: `${DSC}/docs/ai/agentforce-mobile-sdk/guide/agentforce-mobile-sdk-overview.html`,
  },
];

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

const guideArg = arg("guide") ?? "all";
const outDir = arg("out-dir") ?? "/tmp/sfada";
const rawRoot = arg("raw-root") ?? "/tmp/sfada/devdocs-raw";
const fromRaw = arg("from-raw");
const noEmbed = process.argv.includes("--no-embed");

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(DELAY_MS);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      console.error(`    HTTP ${res.status} ${url} (attempt ${attempt})`);
    } catch (err) {
      console.error(`    ${(err as Error).message} ${url} (attempt ${attempt})`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

// Raw page store: fetch from the network into `dir`, or read back a previous run's files
class RawStore {
  constructor(private dir: string, private readOnly: boolean) {
    if (!readOnly) mkdirSync(dir, { recursive: true });
  }
  async get(name: string, url: string): Promise<string | null> {
    const file = path.join(this.dir, name);
    if (this.readOnly) return existsSync(file) ? readFileSync(file, "utf8") : null;
    const text = await fetchText(url);
    if (text !== null) writeFileSync(file, text);
    return text;
  }
}

const fileName = (s: string) => s.replace(/[^\w.-]+/g, "_");

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

// Like ingest-latest.ts splitLong, but never leaves a tail shorter than MIN_CHUNK
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    const limit = Math.min(MAX_CHUNK, rest.length - MIN_CHUNK);
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const clean = (s: string) => s.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
// Code keeps its indentation; only trailing whitespace and blank-line runs are tidied
const cleanCode = (s: string) => s.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "caption",
  "doc-heading", "doc-content-callout", "dx-code-block", "dx-tab-panel-list", "dx-tab-panel",
]);

interface Page { title: string; chunks: { headingPath: string; content: string }[]; text: string }

// Walks a content root, tracking the heading hierarchy. Inline runs (text, links, code spans)
// are joined into one line; every block element starts a new line. Sections shorter than
// MIN_CHUNK are carried into the next section instead of being dropped.
function chunkContent($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>, fallbackTitle: string): Page {
  const title = clean(root.find("h1").first().text().replace(/\s+/g, " ")) || fallbackTitle;
  const chunks: { headingPath: string; content: string }[] = [];
  const allText: string[] = [];
  const headings: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let inline = "";
  let carry = "";

  const headingPath = () => [title, ...headings.filter(Boolean)].join(" > ");
  const flush = () => {
    flushInline();
    let text = lines.join("\n").trim();
    lines = [];
    size = 0;
    if (carry) {
      text = text ? `${carry}\n${text}` : carry;
      carry = "";
    }
    if (!text) return;
    if (text.length < MIN_CHUNK) {
      // Keep the section's own heading with its text when it moves into the next section
      const leaf = headings.filter(Boolean).at(-1);
      carry = leaf && !text.startsWith(leaf) ? `${leaf}\n${text}` : text;
      return;
    }
    for (const part of splitLong(text)) {
      if (part.length >= MIN_CHUNK) chunks.push({ headingPath: headingPath(), content: part });
      else carry = part;
    }
  };
  const pushLine = (t: string) => {
    if (!t) return;
    allText.push(t);
    if (size + t.length + 1 > MAX_CHUNK && size > 0) {
      const pending = inline;
      inline = "";
      flush();
      inline = pending;
    }
    lines.push(t);
    size += t.length + 1;
  };
  const add = (text: string) => pushLine(clean(text));
  const addCode = (code: string) => pushLine(cleanCode(code));
  // Source HTML is hard-wrapped, so newlines inside an inline run are just spaces
  const flat = (s: string) => clean(s.replace(/\s+/g, " "));
  function flushInline() {
    const t = flat(inline);
    inline = "";
    pushLine(t);
  }
  const setHeading = (level: number, text: string) => {
    flush();
    const t = flat(text);
    if (level <= 1 && t === title) return;
    const depth = Math.max(0, level - 2);
    headings.length = depth;
    headings[depth] = t;
    allText.push(t);
  };
  const hasBlock = (el: cheerio.Cheerio<AnyNode>) => el.find([...BLOCK].join(",")).length > 0;
  const inBox = (el: cheerio.Cheerio<AnyNode>) => el.closest(".box, doc-content-callout, table").length > 0;

  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        inline += $(node).text();
        continue;
      }
      if (node.type !== "tag") continue;
      const el = $(node);
      const tag = node.name.toLowerCase();
      if (tag === "br") {
        flushInline();
        continue;
      }
      if (!BLOCK.has(tag)) {
        if (hasBlock(el)) walk(el.contents().toArray());
        else inline += el.text();
        continue;
      }
      flushInline();
      const level = /^h([1-6])$/.exec(tag);
      if (tag === "doc-heading") {
        setHeading(Number(el.attr("aria-level") ?? 2), el.attr("header") ?? el.text());
      } else if (level) {
        // Headings inside notes/callouts/tables ("Note", "Tip") are labels, not sections
        if (inBox(el)) add(`${flat(el.text())}:`);
        else setHeading(Number(level[1]), el.text());
      } else if (tag === "pre") {
        addCode(el.text());
      } else if (tag === "dx-code-block") {
        addCode(el.attr("code-block") ?? el.text());
      } else if (tag === "doc-content-callout") {
        const header = clean(el.attr("header") ?? "");
        if (header) add(`${header}:`);
        walk(el.contents().toArray());
        flushInline();
      } else if (tag === "dx-tab-panel-list") {
        // Tabbed content: label each panel with its tab name
        let labels: string[] = [];
        try {
          labels = JSON.parse(el.attr("tabs") ?? "[]").map((t: { label?: string }) => t.label ?? "");
        } catch {}
        el.children("dx-tab-panel").each((i, panel) => {
          if (labels[i]) add(`${flat(labels[i])}:`);
          walk($(panel).contents().toArray());
          flushInline();
        });
      } else if (tag === "table") {
        el.find("tr").each((_, tr) => {
          if ($(tr).closest("table")[0] !== node) return; // nested tables are read with their cell
          add($(tr).children("th, td").map((_, c) => flat($(c).text())).get().filter(Boolean).join(" | "));
        });
      } else if (tag === "hr") {
        // nothing
      } else {
        walk(el.contents().toArray());
        flushInline();
      }
    }
  };

  walk(root.contents().toArray());
  flush();
  if (carry) {
    const last = chunks.at(-1);
    if (last && last.content.length + carry.length + 1 <= MAX_CHUNK) last.content += `\n${carry}`;
    else if (carry.length >= MIN_CHUNK) chunks.push({ headingPath: headingPath(), content: carry });
  }
  return { title, chunks, text: allText.join("\n") };
}

const STRIP = "script, style, noscript, iframe, svg, img, button, template, input, select, textarea, .pagination";

function chunkAtlas(html: string, fallbackTitle: string): Page | null {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  const root = $("#__root");
  root.find(STRIP).remove();
  return chunkContent($, root, fallbackTitle);
}

function chunkDsc(html: string, fallbackTitle: string): Page | null {
  const $ = cheerio.load(html);
  const root = $("doc-content-layout").first();
  if (!root.length) return null;
  root.find(STRIP).remove();
  // Live component previews (lightning-card etc.) are UI, not documentation
  root.find("*").filter((_, el) => /^lightning-/.test((el as Element).name)).remove();
  return chunkContent($, root, fallbackTitle);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// TOC discovery
// ---------------------------------------------------------------------------

interface TocEntry { url: string; title: string; fetchUrl: string; file: string }

function dedupe(entries: TocEntry[]): TocEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

interface AtlasNode { text: string; a_attr?: { href?: string }; children?: AtlasNode[] }

async function atlasToc(g: Guide, raw: RawStore): Promise<{ entries: TocEntry[]; rootHtml?: string }> {
  const doc = await raw.get("_get_document.json", g.start);
  if (!doc) throw new Error(`Could not fetch TOC ${g.start}`);
  const data = JSON.parse(doc);
  // Follow the live release so future refreshes pick up new versions automatically
  const version = data.version?.doc_version ?? g.version;
  console.error(`  ${g.source}: doc_version ${version}${data.version?.version_text ? ` (${data.version.version_text})` : ""}`);
  const entries: TocEntry[] = [];
  const walk = (nodes: AtlasNode[]) => {
    for (const n of nodes) {
      const href = n.a_attr?.href?.replace(/[?#].*$/, "");
      if (href && /^[\w.-]+\.htm$/.test(href)) {
        entries.push({
          url: `${g.prefix}${href}`,
          title: clean(n.text ?? ""),
          fetchUrl: `${DSC}/docs/get_document_content/${g.deliverable}/${href}/en-us/${version}`,
          file: `${href}.json`,
        });
      } else if (href) {
        console.error(`  skipping non-page TOC href ${href}`);
      }
      walk(n.children ?? []);
    }
  };
  walk(data.toc ?? []);
  return { entries: dedupe(entries), rootHtml: data.content };
}

interface SidebarNode { label: string; name?: string; link?: { href?: string }; children?: SidebarNode[] }

async function dscToc(g: Guide, raw: RawStore): Promise<{ entries: TocEntry[] }> {
  const html = await raw.get("_toc_page.html", g.start);
  if (!html) throw new Error(`Could not fetch TOC page ${g.start}`);
  const $ = cheerio.load(html);
  const attr = $("doc-content-layout").attr("sidebar-content");
  if (!attr) throw new Error(`No sidebar-content on ${g.start}`);
  const entries: TocEntry[] = [];
  const outside = new Set<string>();
  const walk = (nodes: SidebarNode[]) => {
    for (const n of nodes) {
      const href = n.link?.href ?? n.name;
      if (href) {
        let url = new URL(href, DSC).href.replace(/[?#].*$/, "");
        if (!/\.html?$/.test(url) && url.startsWith(g.prefix)) url = `${url.replace(/\/$/, "")}.html`;
        if (url.startsWith(g.prefix) && url.length > g.prefix.length) {
          entries.push({ url, title: clean(n.label ?? ""), fetchUrl: url, file: fileName(url.slice(g.prefix.length)) });
        } else {
          outside.add(url);
        }
      }
      walk(n.children ?? []);
    }
  };
  walk(JSON.parse(attr));
  if (outside.size) console.error(`  ${outside.size} TOC links outside ${g.prefix} skipped: ${[...outside].slice(0, 5).join(", ")}${outside.size > 5 ? ", ..." : ""}`);
  return { entries: dedupe(entries) };
}

// ---------------------------------------------------------------------------
// Per-guide ingest
// ---------------------------------------------------------------------------

const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

interface Report { guide: string; source: string; prefix: string; toc: number; fetched: number; failed: string[]; noChunks: string[]; chunks: number; csv: string; rawDir: string }

async function ingestGuide(g: Guide, rawBase: string, readOnly: boolean): Promise<Report> {
  const rawDir = path.join(rawBase, g.key);
  const raw = new RawStore(rawDir, readOnly);
  console.error(`\n[${g.key}] ${g.source} <- ${g.start}`);
  const { entries, rootHtml } = g.kind === "atlas" ? await atlasToc(g, raw) : { ...(await dscToc(g, raw)), rootHtml: undefined };
  console.error(`  ${entries.length} TOC pages`);

  const rows: Row[] = [];
  const failed: string[] = [];
  const noChunks: string[] = [];
  let fetched = 0;
  const emit = (url: string, page: Page | null) => {
    if (!page || page.chunks.length === 0) {
      noChunks.push(url);
      console.error(`    no chunks: ${url}`);
      return;
    }
    const hash = sha256(page.text);
    // Some pages repeat a section verbatim (e.g. the same code sample under two tabs)
    const seen = new Set<string>();
    for (const c of page.chunks) if (!seen.has(`${c.headingPath}\n${c.content}`) && seen.add(`${c.headingPath}\n${c.content}`)) rows.push({ source: g.source, url, headingPath: c.headingPath, content: c.content, contentHash: hash, publishedAt: "" });
  };

  for (const [i, e] of entries.entries()) {
    const body = await raw.get(e.file, e.fetchUrl);
    let html: string | null = body;
    if (body && g.kind === "atlas") {
      try {
        html = JSON.parse(body).content ?? null;
      } catch {
        html = null;
      }
    }
    if (!html) {
      failed.push(e.url);
      console.error(`    FAILED ${e.url}`);
      continue;
    }
    fetched++;
    emit(e.url, g.kind === "atlas" ? chunkAtlas(html, e.title) : chunkDsc(html, e.title));
    if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${entries.length} pages, ${rows.length} chunks`);
  }
  // The seed keeps a row set for the bare guide root, which serves the guide's landing topic
  if (g.includeRoot && rootHtml) emit(g.prefix, chunkAtlas(rootHtml, ""));

  const csv = path.join(outDir, `devguide-${g.source}.csv`);
  if (noEmbed) writeFileSync(`${csv}.preview.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  else await writeCsv(rows, csv);
  const report: Report = { guide: g.key, source: g.source, prefix: g.prefix, toc: entries.length, fetched, failed, noChunks, chunks: rows.length, csv, rawDir };
  if (!readOnly) writeFileSync(path.join(rawDir, "_report.json"), JSON.stringify(report, null, 2));
  console.error(`  [${g.key}] toc=${entries.length} fetched=${fetched} failed=${failed.length} noChunks=${noChunks.length} chunks=${rows.length}`);
  return report;
}

async function writeCsv(rows: Row[], file: string) {
  console.error(`  embedding ${rows.length} chunks -> ${file}`);
  const out = createWriteStream(file);
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
    if ((i / BATCH) % 10 === 0) console.error(`    ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  await new Promise<void>((resolve) => out.end(resolve));
}

async function main() {
  const guides = guideArg === "all" ? GUIDES : GUIDES.filter((g) => g.key === guideArg);
  if (guides.length === 0) throw new Error(`Unknown --guide ${guideArg}; expected ${GUIDES.map((g) => g.key).join("|")}|all`);
  let rawBase: string;
  if (fromRaw) {
    rawBase = fromRaw;
  } else {
    mkdirSync(rawRoot, { recursive: true });
    rawBase = mkdtempSync(path.join(rawRoot, "run-"));
  }
  console.error(`Raw downloads: ${rawBase}${fromRaw ? " (reusing)" : ""}`);
  const reports: Report[] = [];
  for (const g of guides) reports.push(await ingestGuide(g, rawBase, Boolean(fromRaw)));
  console.error("\nSummary:");
  for (const r of reports) {
    console.error(`  ${r.source}: toc=${r.toc} fetched=${r.fetched} failed=${r.failed.length} noChunks=${r.noChunks.length} chunks=${r.chunks}  --replace-prefix ${r.prefix}`);
    for (const u of r.failed) console.error(`    failed: ${u}`);
    for (const u of r.noChunks) console.error(`    no chunks: ${u}`);
  }
  writeFileSync(path.join(rawBase, `_summary-${guideArg}${fromRaw ? "-rechunk" : ""}.json`), JSON.stringify(reports, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
