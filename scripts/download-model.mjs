#!/usr/bin/env node
/**
 * Downloads the fastembed BGE-small model during Heroku build.
 * Uses system tar (more reliable than Node tar on Heroku).
 */
import https from "https";
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const MODEL = "fast-bge-small-en-v1.5";
const CACHE_DIR = process.env.FASTEMBED_CACHE_DIR || "local_cache";
const MODEL_DIR = path.join(CACHE_DIR, MODEL);
const URL = `https://storage.googleapis.com/qdrant-fastembed/${MODEL}.tar.gz`;

if (existsSync(path.join(MODEL_DIR, "model_optimized.onnx"))) {
  console.log(`Model already cached at ${MODEL_DIR}`);
  process.exit(0);
}

mkdirSync(CACHE_DIR, { recursive: true });

const targz = path.join(CACHE_DIR, `${MODEL}.tar.gz`);
console.log(`Downloading ${URL} ...`);

await new Promise((resolve, reject) => {
  const file = createWriteStream(targz);
  https.get(URL, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      https.get(res.headers.location, (res2) => {
        res2.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
      return;
    }
    if (res.statusCode !== 200) {
      reject(new Error(`HTTP ${res.statusCode}`));
      return;
    }
    const total = parseInt(res.headers["content-length"] || "0");
    let downloaded = 0;
    res.on("data", (chunk) => {
      downloaded += chunk.length;
      if (total > 0 && downloaded % (5 * 1024 * 1024) < chunk.length) {
        console.log(`  ${Math.round((downloaded / total) * 100)}%`);
      }
    });
    res.pipe(file);
    file.on("finish", () => { file.close(); resolve(); });
  }).on("error", reject);
});

console.log(`Extracting to ${CACHE_DIR} ...`);
execSync(`tar -xzf "${targz}" -C "${CACHE_DIR}"`, { stdio: "inherit" });

try { unlinkSync(targz); } catch {}

if (!existsSync(path.join(MODEL_DIR, "model_optimized.onnx"))) {
  console.error("ERROR: model_optimized.onnx not found after extraction");
  process.exit(1);
}

console.log("Model ready.");
