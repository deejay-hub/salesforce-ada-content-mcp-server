// Embedding generation using BGE-Small-EN-V1.5 (384 dimensions) via ONNX runtime.
// The model runs locally — no external API calls needed for vector search.
// Cached in memory (LRU, 500 entries) to avoid re-embedding repeated queries.

import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { LRUCache } from "./cache.js";

let model: FlagEmbedding | null = null;
const embeddingCache = new LRUCache<number[]>(500, 30 * 60 * 1000);

async function getModel(): Promise<FlagEmbedding> {
  if (!model) {
    const cacheDir = process.env.FASTEMBED_CACHE_DIR || "local_cache";
    // Retry with cache wipe — handles corrupted model downloads from interrupted Docker builds
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        model = await FlagEmbedding.init({
          model: EmbeddingModel.BGESmallENV15,
          maxLength: 512,
          cacheDir,
        });
        break;
      } catch (err) {
        console.error(`fastembed init attempt ${attempt}/3 failed: ${(err as Error).message}`);
        if (attempt === 3) throw err;
        const { rmSync } = await import("fs");
        try { rmSync(cacheDir, { recursive: true, force: true }); } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  return model!;
}

// 10s timeout prevents a hung ONNX model from blocking requests indefinitely
const EMBED_TIMEOUT_MS = 10000;

export async function embedText(text: string): Promise<number[]> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const m = await getModel();
  const result = await Promise.race([
    (async () => {
      const embeddings = m.embed([text]);
      for await (const batch of embeddings) {
        return Array.from(batch[0]);
      }
      throw new Error("No embedding produced");
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Embedding timed out")), EMBED_TIMEOUT_MS)
    ),
  ]);

  embeddingCache.set(text, result);
  return result;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const m = await getModel();
  const results: number[][] = [];
  const embeddings = m.embed(texts);
  for await (const batch of embeddings) {
    for (const vec of batch) {
      results.push(Array.from(vec));
    }
  }
  return results;
}
