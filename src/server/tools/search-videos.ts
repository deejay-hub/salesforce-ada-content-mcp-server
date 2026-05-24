import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch, type SearchResult } from "../search.js";

const VIDEO_SOURCES = ["developer-youtube", "architect-youtube", "admin-youtube"];

export function register(server: McpServer) {
  server.tool(
    "search_videos",
    `Search Salesforce YouTube video transcripts from Developer, Architect, and Admin channels using hybrid semantic + keyword search. Returns transcript passages with video URLs and publication dates.

Use this tool when the user wants recorded talks, demos, walkthroughs, conference sessions, or visual explanations. Each result links to the source video. Good for discovering talks on a topic or finding where a concept was explained on video.

Do NOT use for written documentation (use search_docs) or blog posts (use search_blogs).

Returns: ranked transcript passages, each with [channel source], video title, URL, publication date, and transcript content.

Examples:
- search_videos(query: "event-driven architecture")
- search_videos(query: "flow builder walkthrough", sources: ["admin-youtube"])
- search_videos(query: "LWC performance", published_after: "2025-06-01")`,
    {
      query: z.string().min(1).max(500).describe("Search query — topics, features, or natural language"),
      limit: z.number().int().min(1).max(30).optional().describe("Max results (default 10)"),
      sources: z.array(z.enum(["developer-youtube", "architect-youtube", "admin-youtube"])).optional()
        .describe("Filter to specific channels. Omit to search all."),
      published_after: z.string().optional().describe("Only videos published on/after this date (YYYY-MM-DD)"),
      published_before: z.string().optional().describe("Only videos published on/before this date (YYYY-MM-DD)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Token budget — truncates results to fit within this limit"),
    },
    async ({ query, limit, sources, published_after, published_before, max_tokens }) => {
      try {
        const { results, truncated } = await hybridSearch({
          query,
          limit: limit ?? 10,
          sources: sources || VIDEO_SOURCES,
          publishedAfter: published_after,
          publishedBefore: published_before,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No videos found." }] };
        }

        let budget = max_tokens ? max_tokens * 3.5 : Infinity;
        const lines: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const date = r.publishedAt ? new Date(r.publishedAt).toISOString().split("T")[0] : "unknown";
          const heading = r.headingPath.replace(/ > \d+:\d{2}$/, "");
          const entry = `[${i + 1}] ${heading}\n    Source: ${r.url}\n    Published: ${date} | ${r.source}\n    ${r.content.slice(0, 400)}`;
          if (entry.length > budget) break;
          lines.push(entry);
          budget -= entry.length;
        }

        const suffix = truncated ? `\n\n(${results.length} results shown — remaining had lower relevance)` : "";
        return { content: [{ type: "text", text: lines.join("\n\n") + suffix }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Video search temporarily unavailable." }] };
      }
    }
  );
}
