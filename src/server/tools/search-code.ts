import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { codeSearch } from "../code-search.js";

export function register(server: McpServer) {
  server.tool(
    "search_code_samples",
    `Search verified working code from official Salesforce GitHub repositories (forcedotcom + trailheadapps) using hybrid semantic + keyword search. Returns source code with file paths and GitHub URLs.

Use this tool when the user needs implementation examples, working code snippets, or wants to see how a Salesforce API or component is used in practice. Covers Apex classes, LWC components, Aura, triggers, flows, and more.

Do NOT use for documentation explanations (use search_docs) or conceptual guidance (use search_blogs).

Returns: ranked code files, each with org/repo, file path, language, component type, GitHub URL, and source code content.`,
    {
      query: z.string().min(1).max(500).describe("Search query — API names, class names, or natural language"),
      language: z.enum(["apex", "javascript", "typescript", "html", "xml", "java", "python"]).optional().describe("Filter by programming language"),
      component_type: z.enum(["lwc", "aura", "apex-class", "apex-trigger", "flow", "custom-metadata"]).optional().describe("Filter by Salesforce component type"),
      org: z.enum(["forcedotcom", "trailheadapps"]).optional().describe("Filter by GitHub organization"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
      max_tokens: z.number().int().min(100).max(100000).optional().describe("Token budget — truncates results to fit within this limit"),
    },
    async ({ query, language, component_type, org, limit, max_tokens }) => {
      try {
        const results = await codeSearch({ query, language, componentType: component_type, org, limit: limit ?? 5 });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No code samples found." }] };
        }

        let budget = max_tokens ? max_tokens * 3.5 : Infinity;
        const lines: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const meta = `[${i + 1}] ${r.org}/${r.repo} — ${r.filePath}`;
          const tags = [r.language, r.componentType].filter(Boolean).join(", ");
          const codeSlice = r.content.slice(0, Math.min(2000, budget - 200));
          const entry = `${meta}\n    Language: ${tags}\n    URL: ${r.url}\n\n\`\`\`${r.language}\n${codeSlice}\n\`\`\``;
          if (entry.length > budget) break;
          lines.push(entry);
          budget -= entry.length;
        }

        return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Code search temporarily unavailable." }] };
      }
    }
  );
}
