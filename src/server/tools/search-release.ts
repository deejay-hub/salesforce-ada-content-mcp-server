import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hybridSearch } from "../search.js";

export function register(server: McpServer) {
  server.tool(
    "search_release_notes",
    `Search within Salesforce release notes for specific features, changes, or deprecations using hybrid semantic + keyword search. Returns individual release note items with their full content and source URLs.

Use this tool to find details about a specific feature change, deprecation, new limit, or breaking change within a release. Best used after summarize_release when you need to drill into a specific item, or when the user asks about a particular feature's release status.

Do NOT use for a high-level overview of a release (use summarize_release first).

Returns: ranked release note items, each with [release source], heading/feature name, URL, and full item content.

Examples:
- search_release_notes(query: "governor limit increase", release: "summer-26")
- search_release_notes(query: "deprecated removed breaking change", release: "spring-26")
- search_release_notes(query: "LWC reactive property") → searches across all releases`,
    {
      query: z.string().min(1).max(500).describe("Search query — feature names, API names, or natural language like 'batch apex limit changes'"),
      release: z.string().max(50).optional().describe("Release filter in kebab-case: 'summer-26', 'spring-26', 'winter-26'. Omit to search across all releases."),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 10)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Token budget — truncates results to fit within this limit"),
    },
    async ({ query, release, limit, max_tokens }) => {
      try {
        const sources = release
          ? [`release-notes-${release.toLowerCase()}`]
          : undefined;

        // If no specific release, filter to all release note sources
        const sourceFilter = sources || undefined;
        const { results, truncated } = await hybridSearch({
          query,
          limit: limit ?? 10,
          sources: sourceFilter,
          // When no specific release passed, use source prefix matching
          ...((!release) && { sourcePrefix: "release-notes-" }),
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: release ? `No release notes found for '${release}' matching that query.` : "No release notes found." }] };
        }

        let budget = max_tokens ? max_tokens * 3.5 : Infinity;
        const lines: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const date = r.publishedAt ? ` (${new Date(r.publishedAt).toISOString().split("T")[0]})` : "";
          const entry = `[${i + 1}] ${r.headingPath}${date}\n    Source: ${r.url}\n    ${r.content.slice(0, 400)}`;
          if (entry.length > budget) break;
          lines.push(entry);
          budget -= entry.length;
        }

        const suffix = truncated ? "\n\n(Results truncated — remaining had lower relevance)" : "";
        return { content: [{ type: "text", text: lines.join("\n\n") + suffix }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Release notes search temporarily unavailable." }] };
      }
    }
  );
}
