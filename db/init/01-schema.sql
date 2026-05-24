CREATE EXTENSION IF NOT EXISTS vector;

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
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

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
  tsv tsvector,
  UNIQUE (repo, file_path)
);

CREATE TABLE IF NOT EXISTS release_summaries (
  id SERIAL PRIMARY KEY,
  release TEXT NOT NULL,
  persona TEXT NOT NULL,
  summary TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  product TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin(tsv);
CREATE INDEX IF NOT EXISTS chunks_url_idx ON chunks (url);
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source);
CREATE INDEX IF NOT EXISTS chunks_published_at_idx ON chunks (published_at DESC) WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS code_samples_embedding_idx ON code_samples USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS code_samples_tsv_idx ON code_samples USING gin(tsv);
CREATE INDEX IF NOT EXISTS code_samples_language_idx ON code_samples (language);
CREATE INDEX IF NOT EXISTS code_samples_org_idx ON code_samples (org);
CREATE INDEX IF NOT EXISTS code_samples_component_type_idx ON code_samples (component_type);

CREATE UNIQUE INDEX IF NOT EXISTS release_summaries_unique ON release_summaries (release, persona, coalesce(product, 'general'));

-- Trigger for code_samples FTS
CREATE OR REPLACE FUNCTION code_samples_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.api_names, ' '), '')), 'A') ||
    setweight(to_tsvector('simple', NEW.file_path), 'B') ||
    setweight(to_tsvector('english', NEW.content), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'code_samples_tsv_update') THEN
    CREATE TRIGGER code_samples_tsv_update
      BEFORE INSERT OR UPDATE ON code_samples
      FOR EACH ROW EXECUTE FUNCTION code_samples_tsv_trigger();
  END IF;
END $$;
