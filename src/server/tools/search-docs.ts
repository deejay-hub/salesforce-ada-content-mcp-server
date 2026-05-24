import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, type SearchResult } from "../search.js";

const EXCLUDED_SOURCES = [
  "developer-blog",
  "architect-blog",
  "admin-blog",
  "developer-youtube",
  "architect-youtube",
  "admin-youtube",
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function formatResults(results: SearchResult[], maxTokens?: number): string {
  if (!maxTokens) {
    return results
      .map((r, i) => {
        const date = r.publishedAt ? `\n    Published: ${new Date(r.publishedAt).toISOString().split("T")[0]}` : "";
        const heading = r.source.includes("youtube")
          ? r.headingPath.replace(/ > \d+:\d{2}$/, "")
          : r.headingPath;
        return `[${i + 1}] [${r.source}] ${heading} (id:${r.id})\n    Source: ${r.url}${date}\n    ${r.content.slice(0, 300)}`;
      })
      .join("\n\n");
  }

  let budget = maxTokens;
  const lines: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.publishedAt ? `\n    Published: ${new Date(r.publishedAt).toISOString().split("T")[0]}` : "";
    const heading = r.source.includes("youtube")
      ? r.headingPath.replace(/ > \d+:\d{2}$/, "")
      : r.headingPath;
    const meta = `[${i + 1}] [${r.source}] ${heading} (id:${r.id})\n    Source: ${r.url}${date}\n    `;

    const fullEntry = meta + r.content;
    if (estimateTokens(fullEntry) <= budget) {
      lines.push(fullEntry);
      budget -= estimateTokens(fullEntry);
      continue;
    }

    const available = Math.floor(budget * 3.5) - meta.length - 20;
    if (available > 100) {
      lines.push(meta + r.content.slice(0, available) + "...");
    }
    break;
  }

  return lines.join("\n\n");
}

export function register(server: McpServer) {
  server.tool(
    "search_docs",
    `Search official Salesforce developer guides and technical documentation using hybrid semantic + keyword search. Returns ranked passages with source URLs for citation.

Use this tool when you need authoritative technical content: API references, configuration steps, governor limits, platform behavior, or best practices. Covers Apex, LWC, REST API, Bulk API, Data Cloud, Agentforce, MuleSoft, Marketing Cloud, Platform Events, Mobile SDK, and more.

Do NOT use for blogs (use search_blogs), videos (use search_videos), or code examples (use search_code_samples).

Returns: ranked list of passages, each with [source guide], heading path, URL, and content snippet.

Examples:
- search_docs(query: "apex trigger bulkification pattern")
- search_docs(query: "LWC wire adapter getRecord fields", sources: ["lwc-dev-guide"])
- search_docs(query: "Data Cloud calculated insights configuration")`,
    {
      query: z.string().min(1).max(500).describe("The search query — feature names, API methods, or natural language"),
      limit: z.number().int().min(1).max(30).optional().describe("Max results (default 10)"),
      sources: z.array(z.string().max(50)).max(10).optional().describe("Filter to specific doc sources (e.g. ['apex-dev-guide', 'lwc-dev-guide', 'rest-api-dev-guide'])"),
      published_after: z.string().optional().describe("Only content published on/after this date (YYYY-MM-DD)"),
      published_before: z.string().optional().describe("Only content published on/before this date (YYYY-MM-DD)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Token budget — truncates results to fit within this limit"),
    },
    async ({ query, limit, sources, published_after, published_before, max_tokens }) => {
      try {
        const { results, truncated } = await hybridSearch({
          query,
          limit: limit ?? 10,
          sources,
          excludeSources: sources ? undefined : EXCLUDED_SOURCES,
          publishedAfter: published_after,
          publishedBefore: published_before,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No results found." }] };
        }

        const formatted = formatResults(results, max_tokens);
        const suffix = truncated ? `\n\n(${results.length} results shown — remaining had significantly lower relevance)` : "";

        return { content: [{ type: "text", text: formatted + suffix }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Search temporarily unavailable." }] };
      }
    }
  );
}
