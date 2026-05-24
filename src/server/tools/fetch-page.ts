// Fetches full page content as markdown. For Salesforce domains, we serve from the database
// (pre-indexed chunks reassembled into a page). For GitHub, we fetch live and convert HTML.
// This avoids rate-limiting issues and ensures fast, reliable retrieval of indexed content.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as cheerio from "cheerio";
import pool from "../../utils/db.js";

function htmlToMarkdown($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string {
  const lines: string[] = [];

  el.find("script, style, nav, footer, header, .sidebar, .nav, .cookie-banner, .announcement-banner").remove();

  el.find("*").each((_, node) => {
    if (node.type !== "tag") return;
    const $node = $(node);
    const tag = node.tagName.toLowerCase();

    if (tag.match(/^h[1-6]$/)) {
      const level = parseInt(tag[1]);
      const text = $node.text().trim();
      if (text) lines.push(`\n${"#".repeat(level)} ${text}\n`);
    } else if (tag === "p") {
      const text = $node.text().trim();
      if (text) lines.push(`\n${text}\n`);
    } else if (tag === "li") {
      const text = $node.text().trim();
      if (text) lines.push(`- ${text}`);
    } else if (tag === "pre" || tag === "code") {
      if (tag === "pre") {
        const code = $node.text().trim();
        if (code) lines.push(`\n\`\`\`\n${code}\n\`\`\`\n`);
      }
    } else if (tag === "a") {
      const href = $node.attr("href");
      const text = $node.text().trim();
      if (href && text && !href.startsWith("#") && !href.startsWith("javascript:")) {
        $node.replaceWith(`[${text}](${href})`);
      }
    } else if (tag === "table") {
      const rows: string[][] = [];
      $node.find("tr").each((_, tr) => {
        const cells: string[] = [];
        $(tr).find("th, td").each((_, cell) => {
          cells.push($(cell).text().trim());
        });
        if (cells.length) rows.push(cells);
      });
      if (rows.length > 0) {
        lines.push("");
        lines.push("| " + rows[0].join(" | ") + " |");
        lines.push("| " + rows[0].map(() => "---").join(" | ") + " |");
        for (let i = 1; i < rows.length; i++) {
          lines.push("| " + rows[i].join(" | ") + " |");
        }
        lines.push("");
      }
    }
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const ALLOWED_DOMAINS = [
  "salesforce.com",
  "developer.salesforce.com",
  "help.salesforce.com",
  "trailhead.salesforce.com",
  "architect.salesforce.com",
  "admin.salesforce.com",
  "github.com",
];

function isDomainAllowed(urlStr: string): boolean {
  try {
    const { hostname } = new URL(urlStr);
    return ALLOWED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );
  } catch {
    return false;
  }
}

function isGitHub(urlStr: string): boolean {
  try {
    const { hostname } = new URL(urlStr);
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

async function fetchFromDb(url: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT heading_path, content FROM chunks
     WHERE url = $1 ORDER BY id`,
    [url]
  );
  if (rows.length === 0) return null;

  return rows
    .map((r) => {
      const heading = r.heading_path.split(" > ").pop() || "";
      return `## ${heading}\n\n${r.content}`;
    })
    .join("\n\n");
}

// Max 5MB response body to prevent OOM from oversized pages
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function fetchLive(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  // Verify the final URL (after redirects) is still on an allowed domain
  if (res.url && !isDomainAllowed(res.url)) {
    throw new Error("Redirect to disallowed domain");
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }

  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error("Response too large");
  }

  if (contentType.includes("text/html")) {
    const $ = cheerio.load(body);
    const main = $("main, article, [role='main'], .content, .documentation, .article-body").first();
    const root = main.length ? main : $("body");
    const title = $("h1").first().text().trim() || $("title").text().trim();
    return (title ? `# ${title}\n\n` : "") + htmlToMarkdown($, root);
  }

  return body;
}

export function register(server: McpServer) {
  server.tool(
    "fetch_page",
    `Fetch the full content of a Salesforce or GitHub page as clean markdown. For Salesforce domains, returns pre-indexed content from the database (fast, no network call). For GitHub URLs, fetches live content.

Use this tool when you need the complete page content rather than a search snippet — for example, after search_docs returns a relevant URL and you want to read the full guide section, or when the user provides a specific URL they want summarized or analyzed.

Do NOT use for discovery or searching (use search_docs, search_blogs, etc. first). Only use when you already have a specific URL.

Returns: the full page content as markdown text, optionally truncated to a token budget. Supported domains: salesforce.com, developer.salesforce.com, help.salesforce.com, trailhead.salesforce.com, architect.salesforce.com, admin.salesforce.com, github.com.`,
    {
      url: z.string().url().max(500).describe("The URL to fetch (must be salesforce.com, developer.salesforce.com, help.salesforce.com, trailhead.salesforce.com, architect.salesforce.com, admin.salesforce.com, or github.com)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Truncate output to approximately this many tokens"),
    },
    async ({ url, max_tokens }) => {
      if (!isDomainAllowed(url)) {
        return {
          content: [{ type: "text", text: `Domain not allowed. Supported domains: ${ALLOWED_DOMAINS.join(", ")}` }],
        };
      }

      try {
        let markdown: string;

        if (isGitHub(url)) {
          markdown = await fetchLive(url);
        } else {
          const dbContent = await fetchFromDb(url);
          if (dbContent) {
            markdown = dbContent;
          } else {
            markdown = await fetchLive(url);
          }
        }

        if (max_tokens) {
          const maxChars = Math.floor(max_tokens * 3.5);
          if (markdown.length > maxChars) {
            markdown = markdown.slice(0, maxChars) + "\n\n[truncated]";
          }
        }

        return { content: [{ type: "text", text: markdown }] };
      } catch (err) {
        // Only surface safe error messages — don't leak internal network details
        const raw = err instanceof Error ? err.message : "";
        const safe = raw.startsWith("HTTP ") || raw === "Redirect to disallowed domain" || raw === "Response too large"
          ? raw
          : "Could not retrieve page";
        return { content: [{ type: "text", text: `Failed to fetch page: ${safe}` }] };
      }
    }
  );
}
