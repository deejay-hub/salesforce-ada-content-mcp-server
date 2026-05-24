// MCP server entry point — exposes Salesforce content search via streamable HTTP transport.
// Each request creates a fresh MCP server instance (stateless); PostgreSQL + pgvector handles persistence.

import cluster from "node:cluster";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import rateLimit from "express-rate-limit";
import pool, { initSchema } from "../utils/db.js";
import { embedText } from "../utils/embeddings.js";
import { register as registerSearchDocs } from "./tools/search-docs.js";
import { register as registerSearchBlogs } from "./tools/search-blogs.js";
import { register as registerSearchVideos } from "./tools/search-videos.js";
import { register as registerFetchPage } from "./tools/fetch-page.js";
import { register as registerSearchCode } from "./tools/search-code.js";
import { register as registerSearchRelease } from "./tools/search-release.js";
import { register as registerSummarizeRelease } from "./tools/summarize-release.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// 120 req/min per client — prevents runaway agent loops from saturating the server
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false, trustProxy: false },
});

app.set("trust proxy", 1);
app.use(mcpLimiter);

function log(msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), msg, ...data };
  console.log(JSON.stringify(entry));
}

function createServer(): McpServer {
  const server = new McpServer({ name: "Salesforce Content MCP", version: "2.0.0" });
  registerSearchDocs(server);
  registerSearchBlogs(server);
  registerSearchVideos(server);
  registerFetchPage(server);
  registerSearchCode(server);
  registerSearchRelease(server);
  registerSummarizeRelease(server);
  return server;
}

const PORT = parseInt(process.env.PORT || "3000");

// Stateless handler — each request gets its own MCP server + transport (no session affinity needed)
app.post("/salesforce-content-mcp-server", async (req, res, next) => {
  const start = Date.now();
  log("mcp:request", { method: req.body?.method, tool: req.body?.params?.name });
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    log("mcp:response", { method: req.body?.method, ms: Date.now() - start });
  } catch (err) {
    next(err);
  }
});

// Health check verifies DB connectivity — load balancers and orchestrators use this
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log("server:error", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

async function main() {
  // Retry startup — DB may take up to 3 min to import 79K chunks on first boot
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await initSchema();
      break;
    } catch (err) {
      if (attempt === 30) throw err;
      if (attempt % 5 === 1) log("server:waiting-for-db", { attempt, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Warmup: load the ONNX model into memory so the first real query isn't slow
  await embedText("warmup");
  log("server:embeddings-ready");

  const { rows } = await pool.query(
    "SELECT source, COUNT(*) AS chunks FROM chunks GROUP BY source ORDER BY source"
  );
  log("server:start", {
    port: PORT,
    sources: rows.map((r) => `${r.source}(${r.chunks})`),
    totalChunks: rows.reduce((sum, r) => sum + parseInt(r.chunks), 0),
  });

  const server = app.listen(PORT, () => {
    log("server:listening", { port: PORT });
  });

  // Graceful shutdown — finish in-flight requests, then close DB pool
  process.on("SIGTERM", () => {
    log("server:shutting-down");
    server.close(() => {
      pool.end().then(() => process.exit(0));
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => process.exit(1), 10000);
  });
}

// Prevent crashes from unhandled promise rejections (e.g. background pool errors)
process.on("unhandledRejection", (err) => {
  log("server:unhandled-rejection", { error: (err as Error)?.message || String(err) });
});

// Optional clustering for production deployments (e.g. Heroku dynos)
const WEB_CONCURRENCY = parseInt(process.env.WEB_CONCURRENCY || "1");

if (WEB_CONCURRENCY > 1 && cluster.isPrimary) {
  log("cluster:primary", { workers: WEB_CONCURRENCY });
  for (let i = 0; i < WEB_CONCURRENCY; i++) {
    cluster.fork();
  }
  cluster.on("exit", (worker) => {
    log("cluster:worker-exit", { pid: worker.process.pid });
    cluster.fork();
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
