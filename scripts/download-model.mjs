#!/usr/bin/env node
/**
 * Downloads the fastembed BGE-small model during Heroku/Docker build.
 * Uses system tar (more reliable than Node tar on Heroku), with a Hugging Face fallback.
 */
import https from "https";
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const MODEL = "fast-bge-small-en-v1.5";
const CACHE_DIR = process.env.FASTEMBED_CACHE_DIR || "local_cache";
const MODEL_DIR = path.join(CACHE_DIR, MODEL);
const URL = `https://storage.googleapis.com/qdrant-fastembed/${MODEL}.tar.gz`;
// The original GCS bucket now returns 403 — the same ONNX model is published on Hugging Face
const HF_REPO = "Qdrant/bge-small-en-v1.5-onnx-Q";
const HF_FILES = ["config.json", "model_optimized.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"];

if (existsSync(path.join(MODEL_DIR, "model_optimized.onnx"))) {
  console.log(`Model already cached at ${MODEL_DIR}`);
  process.exit(0);
}

mkdirSync(CACHE_DIR, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      https.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && redirects < 5) {
          res.resume();
          get(new globalThis.URL(res.headers.location, u).href, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0");
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total > 5 * 1024 * 1024 && downloaded % (5 * 1024 * 1024) < chunk.length) {
            console.log(`  ${Math.round((downloaded / total) * 100)}%`);
          }
        });
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    };
    get(url);
  });
}

try {
  const targz = path.join(CACHE_DIR, `${MODEL}.tar.gz`);
  console.log(`Downloading ${URL} ...`);
  await download(URL, targz);
  console.log(`Extracting to ${CACHE_DIR} ...`);
  execSync(`tar -xzf "${targz}" -C "${CACHE_DIR}"`, { stdio: "inherit" });
  try { unlinkSync(targz); } catch {}
} catch (err) {
  console.log(`${err.message} — falling back to Hugging Face (${HF_REPO})`);
  mkdirSync(MODEL_DIR, { recursive: true });
  for (const f of HF_FILES) {
    console.log(`Downloading ${f} ...`);
    await download(`https://huggingface.co/${HF_REPO}/resolve/main/${f}`, path.join(MODEL_DIR, f));
  }
}

if (!existsSync(path.join(MODEL_DIR, "model_optimized.onnx"))) {
  console.error("ERROR: model_optimized.onnx not found after extraction");
  process.exit(1);
}

console.log("Model ready.");
