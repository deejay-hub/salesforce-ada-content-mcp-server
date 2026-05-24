import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pool from "../../utils/db.js";

export function register(server: McpServer) {
  server.tool(
    "summarize_release",
    `Get a pre-generated, role-based executive summary of a Salesforce release. Returns a structured overview of breaking changes, new features, and action items tailored to the chosen persona (admin, developer, or architect).

Use this tool FIRST when users ask "what's new", "what changed", or want to understand a release. It returns a high-level narrative summary, not individual items. After reading the summary, use search_release_notes to drill into specifics.

Do NOT use for searching specific features (use search_release_notes). Do NOT use for documentation (use search_docs).

Returns: a structured markdown summary with sections for breaking changes, key features, and recommended actions, tailored to the persona. Includes the chunk_count (number of release note items analyzed) and generation date.

Workflow: (1) Call with release + persona for a full overview. (2) Add product filter to narrow scope. (3) Use search_release_notes for details on specific items.

Examples:
- summarize_release(release: "summer-26", persona: "developer")
- summarize_release(release: "summer-26", persona: "admin", product: "flow")
- summarize_release(release: "spring-26", persona: "architect", product: "security")`,
    {
      release: z.string().max(50).describe("Release identifier in kebab-case: 'summer-26', 'spring-26', 'winter-26'"),
      persona: z.enum(["admin", "developer", "architect"]).describe(
        "Target audience: 'admin' = declarative features, UI, Setup changes; 'developer' = APIs, Apex, LWC, tooling, governor limits, breaking changes; 'architect' = scalability, security posture, integration, limits, design impact"
      ),
      product: z.enum(["apex", "lwc", "flow", "data-cloud", "integration", "agentforce", "security", "platform", "mobile", "general"]).optional()
        .describe("Narrow to a product area. Omit or use 'general' for the full cross-product summary covering all areas."),
    },
    async ({ release, persona, product }) => {
      try {
        const rel = release.toLowerCase();
        const prod = product || "general";

        const { rows } = await pool.query(
          `SELECT summary, chunk_count, created_at FROM release_summaries
           WHERE release = $1 AND persona = $2 AND coalesce(product, 'general') = $3`,
          [rel, persona, prod]
        );

        if (rows.length === 0) {
          const { rows: sourceCheck } = await pool.query(
            "SELECT COUNT(*) AS count FROM chunks WHERE source = $1",
            [`release-notes-${rel}`]
          );

          if (parseInt(sourceCheck[0].count) === 0) {
            return { content: [{ type: "text", text: `No release notes found for '${rel}'. Available releases can be found via search_release_notes.` }] };
          }

          return { content: [{ type: "text", text: `Summary for '${rel}' (${persona}${prod !== "general" ? `, ${prod}` : ""}) has not been generated yet.` }] };
        }

        const row = rows[0];
        const generated = new Date(row.created_at).toISOString().split("T")[0];
        const title = rel.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        const productLabel = prod !== "general" ? ` — ${prod}` : "";
        const header = `# ${title} Release Summary (${persona}${productLabel})\n_Generated ${generated} from ${row.chunk_count} release note sections_\n\n`;

        return { content: [{ type: "text", text: header + row.summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Failed to retrieve release summary." }] };
      }
    }
  );
}
