<div align="center">
	<img width="50" src="images/salesforce-logo.png" alt="Salesforce">
	<h1>Salesforce Content MCP Server</h1>
</div>

<h4 align="center">
	<a href="#overview">Overview</a> |
	<a href="#setup">Setup</a> |
	<a href="#how-it-works">How it Works</a> |
	<a href="#faqs">FAQs</a> |
	<a href="#contributing">Contribute</a>
</h4>

<h3 align="center">
	A self-hostable content MCP server for Salesforce documentation<br><br>
</h3>

## Overview

> **Disclaimer:** This is a community project and not an official Salesforce product. It is not supported, endorsed, or maintained by Salesforce.

Pre-loaded with 87,000+ chunks across developer guides, MuleSoft docs, Marketing Cloud docs, release notes, blogs, videos, and code samples. No API keys, no crawling, no configuration — just `docker compose up`.

Supports **Claude Code**, **Cursor**, **Windsurf**, and any MCP-compatible client.

> Looking for learning and decision-making skills? See the [Salesforce Ada Agent Skills repo](https://github.com/deejay-hub/salesforce-ada-agent-skills).

| Tool | Purpose |
|------|---------|
| `search_docs` | Find authoritative technical content — API references, configuration guides, governor limits, best practices across all developer guides |
| `search_blogs` | Find announcements, tutorials, opinion pieces, and how-to articles from Developer, Architect, and Admin blogs |
| `search_videos` | Find recorded talks, demos, and conference sessions from Salesforce YouTube channels (searches transcripts) |
| `search_code_samples` | Find verified working code from official Salesforce GitHub repos (forcedotcom + trailheadapps) |
| `search_release_notes` | Find specific feature changes, deprecations, or limit increases within a release |
| `summarize_release` | Get a high-level overview of what changed in a release, tailored to admin/developer/architect persona |
| `fetch_page` | Retrieve the full content of a specific Salesforce or GitHub URL as markdown |

## Setup

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac, Windows, or Linux)

**System requirements:**

| Resource | Minimum |
|----------|---------|
| Disk space | ~2 GB (Docker images + database) |
| RAM | ~600 MB (database ~100 MB + server ~500 MB) |
| First boot time | 2-3 minutes (seed data import) |
| Language | English only |

1. Clone this repository:
   ```bash
   git clone https://github.com/deejay-hub/salesforce-ada-content-mcp-server.git
   cd salesforce-ada-content-mcp-server
   ```

2. Start the server:
   ```bash
   docker compose up
   ```

3. You'll see `server:listening` in the logs when it's ready. The MCP endpoint is:
   ```
   http://localhost:3000/salesforce-content-mcp-server
   ```

4. Connect your AI agent — add this to your MCP client config:
   ```json
   {
     "mcpServers": {
       "salesforce-docs": {
         "type": "streamable-http",
         "url": "http://localhost:3000/salesforce-content-mcp-server"
       }
     }
   }
   ```

#### Run Without Docker

If you prefer to run the server directly:

```bash
# Start just the database
docker compose up db

# In another terminal
cp .env.example .env
npm install
npm run build
npm start
```

## How it Works

```
AI Agent → MCP Protocol → Express Server → Hybrid Search → PostgreSQL + pgvector
                                                ↓
                                    Semantic (BGE-Small embeddings, 384-dim)
                                    + Keyword (PostgreSQL full-text search)
                                    → merged via Reciprocal Rank Fusion
```

### Content Included

- **Developer Guides** — Apex, LWC, Agentforce, Agentforce Vibes, Agentforce Mobile SDK, REST API, Bulk API, Data Cloud, Platform Events, Mobile SDK, and more
- **MuleSoft** — Full documentation set (51,000+ chunks)
- **Marketing Cloud** — Growth, Engagement APIs, AMPscript, Account Engagement
- **Architect** — Decision guides, Well-Architected, fundamentals, reference diagrams, blog posts and YouTube content
- **Release Notes** — Winter '27 and Summer '26 release notes with AI-generated summaries
- **Blogs & Videos** — Last year of Developer, Admin, and Architect content
- **Code Samples** — Verified working code from trailheadapps and forcedotcom GitHub orgs

### Stopping & Resetting

```bash
# Stop everything
docker compose down

# Stop and delete all data (next start will re-import from seed files)
docker compose down -v
```

### Refreshing the Data

The seed data is a point-in-time snapshot, but you can refresh it from the live Salesforce sites at any time:

```bash
npm install
npm run refresh            # or: ./scripts/refresh-content.sh
docker compose down -v
docker compose up --build
```

This rewrites the seed files in `db/init/` and is safe to re-run — each step either adds only what's new or fully replaces its slice of the data:

| Step | What it does |
|------|--------------|
| `blogs` | Adds new Developer, Admin, and Architect blog posts and Salesforce Developers / Architects / Admins YouTube videos (from transcripts), and drops blog/video content older than one year |
| `release-notes` | Detects the latest release on help.salesforce.com and replaces that release's notes. Generates the 30 role-based summaries used by `summarize_release` only when the release doesn't have any yet |
| `decision-guides` | Replaces the architect.salesforce.com decision guides |
| `dev-guides` | Replaces the Apex, LWC, Agentforce, Agentforce Vibes, and Agentforce Mobile SDK developer guides, following the live doc version |

**Requirements:** Node 20+, Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (for videos), and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) logged in (only when release summaries are generated). A full run takes 1–2 hours, mostly polite page-by-page fetching.

Run just some steps, or force new release summaries:

```bash
./scripts/refresh-content.sh --only blogs                       # weekly blogs + videos top-up
./scripts/refresh-content.sh --only release-notes,dev-guides    # after a new release
./scripts/refresh-content.sh --only release-notes --resummarize
```

Commit the updated `db/init/` files to share the refresh. The individual ingest scripts in `scripts/` (`ingest-latest.ts`, `ingest-release-notes.ts`, `ingest-architect-decision-guides.ts`, `ingest-dev-guides.ts`, `merge-seed.py`) can also be run on their own — see the usage notes at the top of each.

To update from a production database instead:

```bash
DATABASE_URL=postgres://... ./scripts/export-from-production.sh
docker compose down -v
docker compose up
```

## FAQs

#### Is this kept up to date?

The documentation content is a point-in-time snapshot. Blogs, videos, Winter '27 release notes, the architect decision guides, and the Apex, LWC, Agentforce, Agentforce Vibes, and Agentforce Mobile SDK developer guides were refreshed in October 2026; the remaining content is from May 2026. This project is primarily an example of what can be done with a self-hosted documentation MCP server and may not be actively maintained or refreshed with new content.

#### Why hybrid search instead of just embeddings?

Pure semantic search misses exact API names, governor limit numbers, and config keys. Pure keyword search misses intent. Combining both via Reciprocal Rank Fusion gives the best of both — conceptual understanding plus exact-match precision.

#### Can I use this without Docker?

Yes. Run PostgreSQL with pgvector yourself, point `DATABASE_URL` at it, import the seed data, and start the server with `npm start`. Docker just wraps this for convenience.

#### Port 5432 is already in use

If you already run PostgreSQL locally, `docker compose up` fails with `bind: address already in use`. Pick another host port for the database by adding it to a `.env` file next to `docker-compose.yml`, then recreate the containers:

```bash
echo "DB_PORT=5433" >> .env
docker compose up -d --force-recreate
```

The MCP server talks to the database inside Docker, so its endpoint doesn't change. If you run the server without Docker, use the same port in `DATABASE_URL`.

#### Server keeps restarting on first boot

This is normal. The database needs a few minutes to import seed data. The server will automatically retry and stabilize once the import completes.

#### Port 5432 already in use

Another PostgreSQL instance is running locally. Either stop it or change the port mapping in `docker-compose.yml` to e.g. `"5433:5432"`.

#### Port 3000 already in use

Change the port mapping to e.g. `"3001:3000"` and use `http://localhost:3001/salesforce-content-mcp-server` in your client config.

## Contributing

Contributions are greatly appreciated. Issues and pull requests are welcome.

## License

MIT
