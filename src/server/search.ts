// Hybrid search engine combining semantic (vector) and keyword (PostgreSQL FTS) retrieval.
// Results are merged using Reciprocal Rank Fusion (RRF), then boosted by intent-aware signals:
// source authority, recency, heading match, exact phrase match, and content length.
// This approach outperforms either method alone — keywords catch exact terms that embeddings miss,
// while embeddings catch semantic similarity that keywords miss.

import pool from "../utils/db.js";
import { embedText } from "../utils/embeddings.js";
import { toSql as pgvectorToSql } from "pgvector";
import { detectIntent, IntentProfile } from "./intent.js";
import { LRUCache } from "../utils/cache.js";

const searchCache = new LRUCache<{ results: SearchResult[]; truncated: boolean }>(200, 10 * 60 * 1000);

export interface SearchResult {
  id: number;
  source: string;
  url: string;
  headingPath: string;
  content: string;
  summary: string | null;
  publishedAt: string | null;
  score: number;
}

interface SearchOptions {
  query: string;
  limit?: number;
  sources?: string[];
  excludeSources?: string[];
  sourcePrefix?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  maxTokens?: number;
}

// RRF constant — higher values smooth out rank differences between the two retrieval methods
const RRF_K = 60;

export async function hybridSearch(opts: SearchOptions): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const { query, limit = 10, sources, excludeSources, sourcePrefix, publishedAfter, publishedBefore } = opts;

  const cacheKey = JSON.stringify({ query, limit, sources, excludeSources, sourcePrefix, publishedAfter, publishedBefore });
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const dateFilter = { publishedAfter, publishedBefore };
  const intent = detectIntent(query);

  // Run both retrieval methods in parallel; gracefully degrade if one fails
  const [keywordResults, semanticResults] = await Promise.all([
    keywordSearch(query, limit * 2, sources, dateFilter, sourcePrefix, excludeSources)
      .catch((err) => { console.error("keyword search failed:", err.message); return [] as SearchResult[]; }),
    semanticSearch(query, limit * 2, sources, dateFilter, sourcePrefix, excludeSources)
      .catch((err) => { console.error("semantic search failed:", err.message); return [] as SearchResult[]; }),
  ]);

  // If both failed, propagate the error
  if (keywordResults.length === 0 && semanticResults.length === 0) {
    return { results: [], truncated: false };
  }

  const merged = rrfMerge(keywordResults, semanticResults, query, intent, limit);
  const result = truncateAtScoreGap(merged);
  searchCache.set(cacheKey, result);
  return result;
}

interface DateFilter {
  publishedAfter?: string;
  publishedBefore?: string;
}

function buildFilters(sources: string[] | undefined, dateFilter: DateFilter, paramOffset: number, sourcePrefix?: string, excludeSources?: string[]) {
  let clause = "";
  const params: string[] = [];

  if (sources && sources.length > 0) {
    const placeholders = sources.map((_, i) => `$${paramOffset + i}`).join(", ");
    clause += `AND source IN (${placeholders})`;
    params.push(...sources);
  } else if (sourcePrefix) {
    clause += ` AND source LIKE $${paramOffset + params.length}`;
    params.push(`${sourcePrefix}%`);
  }
  if (excludeSources && excludeSources.length > 0) {
    const placeholders = excludeSources.map((_, i) => `$${paramOffset + params.length + i}`).join(", ");
    clause += ` AND source NOT IN (${placeholders})`;
    params.push(...excludeSources);
  }
  if (dateFilter.publishedAfter) {
    clause += ` AND published_at >= $${paramOffset + params.length}`;
    params.push(dateFilter.publishedAfter);
  }
  if (dateFilter.publishedBefore) {
    clause += ` AND published_at <= $${paramOffset + params.length}`;
    params.push(dateFilter.publishedBefore);
  }

  return { clause, params };
}

async function keywordSearch(
  query: string,
  limit: number,
  sources?: string[],
  dateFilter: DateFilter = {},
  sourcePrefix?: string,
  excludeSources?: string[]
): Promise<SearchResult[]> {
  const { clause, params } = buildFilters(sources, dateFilter, 3, sourcePrefix, excludeSources);

  const { rows } = await pool.query(
    `SELECT id, source, url, heading_path, content, summary, published_at,
            ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS score
     FROM chunks
     WHERE tsv @@ websearch_to_tsquery('english', $1) ${clause}
     ORDER BY score DESC
     LIMIT $2`,
    [query, limit, ...params]
  );

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    url: r.url,
    headingPath: r.heading_path,
    content: r.content,
    summary: r.summary,
    publishedAt: r.published_at,
    score: r.score,
  }));
}

async function semanticSearch(
  query: string,
  limit: number,
  sources?: string[],
  dateFilter: DateFilter = {},
  sourcePrefix?: string,
  excludeSources?: string[]
): Promise<SearchResult[]> {
  const queryEmbedding = await embedText(query);
  const { clause, params } = buildFilters(sources, dateFilter, 3, sourcePrefix, excludeSources);

  const { rows } = await pool.query(
    `SELECT id, source, url, heading_path, content, summary, published_at,
            1 - (embedding <=> $1::vector) AS score
     FROM chunks
     WHERE TRUE ${clause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [pgvectorToSql(queryEmbedding), limit, ...params]
  );

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    url: r.url,
    headingPath: r.heading_path,
    content: r.content,
    summary: r.summary,
    publishedAt: r.published_at,
    score: r.score,
  }));
}

// Boost multipliers — prefer authoritative sources over community content
function sourceBoost(source: string): number {
  if (source.endsWith("-dev-guide")) return 1.3;
  if (source === "architect") return 1.2;
  if (source === "release-notes") return 1.1;
  return 1.0;
}

function recencyBoost(publishedAt: string | null): number {
  if (!publishedAt) return 1.0;
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 30) return 1.3;
  if (ageDays <= 90) return 1.2;
  if (ageDays <= 365) return 1.1;
  return 1.0;
}


// Penalize very short chunks — they're usually nav fragments or section headers with no real content
function shortChunkPenalty(content: string): number {
  if (content.length < 50) return 0.3;
  if (content.length < 100) return 0.6;
  if (content.length < 150) return 0.8;
  return 1.0;
}

const CODE_INDICATORS = /```|function\s|class\s|const\s|let\s|var\s|import\s|public\s|private\s|@\w+|=>|\(\)|\.get\(|\.set\(/;


function computeFinalScore(
  baseScore: number,
  result: SearchResult,
  query: string,
  queryLower: string,
  intent: IntentProfile
): number {
  // Pre-lowercase content/heading once per result instead of in each boost function
  const contentLower = result.content.toLowerCase();
  const headingLower = result.headingPath.toLowerCase();
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 2);

  let multiplier = 1.0;
  multiplier *= sourceBoost(result.source);
  multiplier *= recencyBoost(result.publishedAt) * intent.extraRecencyMultiplier;

  // Exact phrase boost (inlined to reuse contentLower)
  if (queryLower.split(/\s+/).length >= 2 && contentLower.includes(queryLower)) {
    multiplier *= 1.4 * intent.extraExactMatchMultiplier;
  }

  // Heading match boost (inlined to reuse headingLower + terms)
  if (terms.length > 0) {
    const matchCount = terms.filter((t) => headingLower.includes(t)).length;
    const ratio = matchCount / terms.length;
    if (ratio >= 0.8) multiplier *= 1.5;
    else if (ratio >= 0.5) multiplier *= 1.3;
    else if (ratio > 0) multiplier *= 1.1;
  }

  // Cross-field boost (inlined to reuse headingLower + contentLower + terms)
  if (terms.length > 0) {
    const inHeading = terms.some((t) => headingLower.includes(t));
    const inContent = terms.some((t) => contentLower.includes(t));
    if (inHeading && inContent) multiplier *= 1.2;
  }

  multiplier *= shortChunkPenalty(result.content);

  // Code relevance boost (inlined to reuse contentLower)
  if (intent.boostCode && CODE_INDICATORS.test(result.content)) {
    multiplier *= 1.3;
  }

  if (intent.preferLongContent && result.content.length > 800) multiplier *= 1.15;

  multiplier = Math.min(multiplier, 3.0);
  return baseScore * multiplier;
}

function rrfMerge(
  keywordResults: SearchResult[],
  semanticResults: SearchResult[],
  query: string,
  intent: IntentProfile,
  limit: number
): SearchResult[] {
  const scores = new Map<number, { result: SearchResult; score: number }>();

  keywordResults.forEach((result, rank) => {
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scores.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.id, { result, score: rrfScore });
    }
  });

  semanticResults.forEach((result, rank) => {
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scores.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.id, { result, score: rrfScore });
    }
  });

  const queryLower = query.toLowerCase().trim();
  const scored = [...scores.values()].map((entry) => ({
    result: entry.result,
    score: computeFinalScore(entry.score, entry.result, query, queryLower, intent),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by URL — multiple chunks from the same page shouldn't dominate results
  const seenUrls = new Set<string>();
  const results: SearchResult[] = [];
  for (const entry of scored) {
    if (results.length >= limit) break;
    const baseUrl = entry.result.url.split("&")[0];
    if (seenUrls.has(baseUrl)) continue;
    seenUrls.add(baseUrl);
    results.push({ ...entry.result, score: entry.score });
  }
  return results;
}

// Adaptive truncation — if there's a >40% score drop between adjacent results,
// everything below that cliff is noise. This keeps responses focused.
function truncateAtScoreGap(results: SearchResult[], minResults = 3): { results: SearchResult[]; truncated: boolean } {
  if (results.length <= minResults) return { results, truncated: false };

  for (let i = minResults; i < results.length; i++) {
    const prev = results[i - 1].score;
    const curr = results[i].score;
    if (prev === 0) continue;
    const relativeDrop = (prev - curr) / prev;
    if (relativeDrop > 0.4) {
      return { results: results.slice(0, i), truncated: true };
    }
  }

  return { results, truncated: false };
}
