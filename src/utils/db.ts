// PostgreSQL connection pool with pgvector support.
// Auto-detects local (Docker/localhost) vs remote (Heroku/RDS) and adjusts SSL accordingly.

import pg from "pg";

const url = process.env.DATABASE_URL || "";
// Docker Compose uses hostname "db"; skip SSL for local connections
const isLocal = url.includes("localhost") || url.includes("@db:");

const pool = new pg.Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

// Tune HNSW search on every new connection for better recall at query time
pool.on("connect", async (client) => {
  await client.query("SET hnsw.ef_search = 40");
  // relaxed_order allows approximate results when the index is still building — not all PG versions support it
  await client.query("SET hnsw.iterative_scan = relaxed_order").catch(() => {});
});

// Ensures schema exists — idempotent, safe to call on every startup.
// The seed data (db/init/) pre-creates these tables, but this handles the case where
// someone runs the server against a fresh database without the seed import.
// Uses a single client to avoid pool checkout overhead for sequential DDL.
export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'default',
      url TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(384),
      summary TEXT,
      content_hash TEXT,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'chunks_tsv_idx'
      ) THEN
        ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
        CREATE INDEX chunks_tsv_idx ON chunks USING gin(tsv);
      END IF;
    END $$
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chunks_url_idx ON chunks (url)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chunks_published_at_idx ON chunks (published_at DESC) WHERE published_at IS NOT NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS release_summaries (
      id SERIAL PRIMARY KEY,
      release TEXT NOT NULL,
      persona TEXT NOT NULL,
      summary TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (release, persona)
    )
  `);

  // Code samples from forcedotcom + trailheadapps GitHub orgs
  await client.query(`
    CREATE TABLE IF NOT EXISTS code_samples (
      id SERIAL PRIMARY KEY,
      repo TEXT NOT NULL,
      org TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT NOT NULL,
      language TEXT NOT NULL,
      component_type TEXT,
      content TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      embedding vector(384),
      content_hash TEXT,
      api_names TEXT[],
      indexed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (repo, file_path)
    )
  `);

  // Weighted FTS: API names (A) > file paths (B) > content (C) — trigger-based because
  // generated columns can't reference multiple fields with setweight on all PG versions
  await client.query(`ALTER TABLE code_samples ADD COLUMN IF NOT EXISTS tsv tsvector`);
  await client.query(`CREATE INDEX IF NOT EXISTS code_samples_tsv_idx ON code_samples USING gin(tsv)`);
  await client.query(`
    CREATE OR REPLACE FUNCTION code_samples_tsv_trigger() RETURNS trigger AS $$
    BEGIN
      NEW.tsv :=
        setweight(to_tsvector('english', coalesce(array_to_string(NEW.api_names, ' '), '')), 'A') ||
        setweight(to_tsvector('simple', NEW.file_path), 'B') ||
        setweight(to_tsvector('english', NEW.content), 'C');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'code_samples_tsv_update') THEN
        CREATE TRIGGER code_samples_tsv_update
          BEFORE INSERT OR UPDATE ON code_samples
          FOR EACH ROW EXECUTE FUNCTION code_samples_tsv_trigger();
      END IF;
    END $$
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS code_samples_embedding_idx
    ON code_samples USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS code_samples_language_idx ON code_samples (language)`);
  await client.query(`CREATE INDEX IF NOT EXISTS code_samples_org_idx ON code_samples (org)`);
  await client.query(`CREATE INDEX IF NOT EXISTS code_samples_component_type_idx ON code_samples (component_type)`);

  // Migration: add product dimension so summaries can be filtered by area (e.g. "flow", "apex")
  await client.query(`ALTER TABLE release_summaries ADD COLUMN IF NOT EXISTS product TEXT`);
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'release_summaries_release_persona_key'
      ) THEN
        ALTER TABLE release_summaries DROP CONSTRAINT release_summaries_release_persona_key;
      END IF;
    END $$
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS release_summaries_unique
    ON release_summaries (release, persona, coalesce(product, 'general'))
  `);
  } finally {
    client.release();
  }
}

export default pool;
