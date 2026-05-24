// Hybrid search over code samples from official Salesforce GitHub repos.
// Same RRF approach as doc search, with code-specific boosts for API name matches,
// file path relevance, and trailheadapps (curated learning examples).

import pool from "../utils/db.js";
import { embedText } from "../utils/embeddings.js";
import { toSql as pgvectorToSql } from "pgvector";
import { LRUCache } from "../utils/cache.js";

export interface CodeSearchResult {
  id: number;
  repo: string;
  org: string;
  filePath: string;
  url: string;
  language: string;
  componentType: string | null;
  content: string;
  headingPath: string;
  score: number;
}

export interface CodeSearchOptions {
  query: string;
  language?: string;
  componentType?: string;
  org?: string;
  limit?: number;
}

const codeCache = new LRUCache<CodeSearchResult[]>(100, 10 * 60 * 1000);

function buildFilters(opts: CodeSearchOptions, startParam: number): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.language) {
    params.push(opts.language);
    conditions.push(`language = $${startParam + params.length - 1}`);
  }
  if (opts.componentType) {
    params.push(opts.componentType);
    conditions.push(`component_type = $${startParam + params.length - 1}`);
  }
  if (opts.org) {
    params.push(opts.org);
    conditions.push(`org = $${startParam + params.length - 1}`);
  }

  return {
    clause: conditions.length > 0 ? " AND " + conditions.join(" AND ") : "",
    params,
  };
}

async function keywordCodeSearch(query: string, limit: number, opts: CodeSearchOptions): Promise<CodeSearchResult[]> {
  const { clause, params } = buildFilters(opts, 3);
  const { rows } = await pool.query(
    `SELECT id, repo, org, file_path, url, language, component_type, content, heading_path,
            ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS score
     FROM code_samples
     WHERE tsv @@ websearch_to_tsquery('english', $1)${clause}
     ORDER BY score DESC
     LIMIT $2`,
    [query, limit, ...params]
  );

  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    org: r.org,
    filePath: r.file_path,
    url: r.url,
    language: r.language,
    componentType: r.component_type,
    content: r.content,
    headingPath: r.heading_path,
    score: parseFloat(r.score),
  }));
}

async function semanticCodeSearch(query: string, limit: number, opts: CodeSearchOptions): Promise<CodeSearchResult[]> {
  const queryEmbedding = await embedText(query);
  const { clause, params } = buildFilters(opts, 3);

  const { rows } = await pool.query(
    `SELECT id, repo, org, file_path, url, language, component_type, content, heading_path,
            1 - (embedding <=> $1::vector) AS score
     FROM code_samples
     WHERE TRUE${clause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [pgvectorToSql(queryEmbedding), limit, ...params]
  );

  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    org: r.org,
    filePath: r.file_path,
    url: r.url,
    language: r.language,
    componentType: r.component_type,
    content: r.content,
    headingPath: r.heading_path,
    score: parseFloat(r.score),
  }));
}

export async function codeSearch(opts: CodeSearchOptions): Promise<CodeSearchResult[]> {
  const { query, limit = 5 } = opts;

  const cacheKey = JSON.stringify(opts);
  const cached = codeCache.get(cacheKey);
  if (cached) return cached;

  const fetchLimit = limit * 2;
  const [keywordResults, semanticResults] = await Promise.all([
    keywordCodeSearch(query, fetchLimit, opts),
    semanticCodeSearch(query, fetchLimit, opts),
  ]);

  // RRF merge
  const RRF_K = 60;
  const scoreMap = new Map<number, { result: CodeSearchResult; score: number }>();

  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    scoreMap.set(r.id, { result: r, score: rrfScore });
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(r.id, { result: r, score: rrfScore });
    }
  }

  // Code-specific boosts: exact API matches, file path relevance, trailheadapps preference
  const queryLower = query.toLowerCase();
  const results = [...scoreMap.values()]
    .map(({ result, score }) => {
      let boost = 1.0;

      // Boost exact API name matches
      if (result.content.toLowerCase().includes(queryLower)) {
        boost *= 1.4;
      }

      // Boost file path matches
      if (result.filePath.toLowerCase().includes(queryLower.replace(/\s+/g, ""))) {
        boost *= 1.5;
      }

      // Boost trailheadapps (curated examples)
      if (result.org === "trailheadapps") {
        boost *= 1.2;
      }

      // Boost longer, more complete examples
      if (result.content.length > 500) {
        boost *= 1.1;
      }

      return { ...result, score: score * Math.min(boost, 3.0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  codeCache.set(cacheKey, results);
  return results;
}
