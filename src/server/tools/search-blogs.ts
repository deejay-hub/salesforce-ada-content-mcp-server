import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, type SearchResult } from "../search.js";

const BLOG_SOURCES = ["developer-blog", "architect-blog", "admin-blog"];

export function register(server: McpServer) {
  server.tool(
    "search_blogs",
    `Search Salesforce blog posts from Developer, Architect, and Admin blogs using hybrid semantic + keyword search. Returns blog passages with URLs and publication dates.

Use this tool for announcements, tutorials, opinion pieces, how-to articles, and community advocacy content. Blog content is more opinionated and current than developer guides — good for "what's new", patterns, and real-world advice.

Do NOT use for official documentation (use search_docs) or video content (use search_videos).

Returns: ranked passages, each with [blog source], title/heading, URL, publication date, and content snippet.

Examples:
- search_blogs(query: "event-driven architecture patterns")
- search_blogs(query: "flow best practices", sources: ["admin-blog"])
- search_blogs(query: "what's new apex", published_after: "2026-01-01")`,
    {
      query: z.string().min(1).max(500).describe("Search query — topics, features, or natural language"),
      limit: z.number().int().min(1).max(30).optional().describe("Max results (default 10)"),
      sources: z.array(z.enum(["developer-blog", "architect-blog", "admin-blog"])).optional()
        .describe("Filter to specific blogs. Omit to search all."),
      published_after: z.string().optional().describe("Only posts published on/after this date (YYYY-MM-DD)"),
      published_before: z.string().optional().describe("Only posts published on/before this date (YYYY-MM-DD)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Token budget — truncates results to fit within this limit"),
    },
    async ({ query, limit, sources, published_after, published_before, max_tokens }) => {
      try {
        const { results, truncated } = await hybridSearch({
          query,
          limit: limit ?? 10,
          sources: sources || BLOG_SOURCES,
          publishedAfter: published_after,
          publishedBefore: published_before,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No blog posts found." }] };
        }

        let budget = max_tokens ? max_tokens * 3.5 : Infinity;
        const lines: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const date = r.publishedAt ? new Date(r.publishedAt).toISOString().split("T")[0] : "unknown";
          const entry = `[${i + 1}] ${r.headingPath}\n    Source: ${r.url}\n    Published: ${date} | ${r.source}\n    ${r.content.slice(0, 400)}`;
          if (entry.length > budget) break;
          lines.push(entry);
          budget -= entry.length;
        }

        const suffix = truncated ? `\n\n(${results.length} results shown — remaining had lower relevance)` : "";
        return { content: [{ type: "text", text: lines.join("\n\n") + suffix }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Blog search temporarily unavailable." }] };
      }
    }
  );
}
