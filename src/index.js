import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createRevalidationNotifier } from "./revalidate.js";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPostsDirectory = path.resolve(projectDirectory, "..", "content", "posts");
const postsDirectory = path.resolve(process.env.POSTS_DIR || defaultPostsDirectory);
const port = Number(process.env.PORT || 4000);

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function trustProxyEnv(raw) {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback" or a comma-separated subnet list
}

// ALLOWED_ORIGINS is the current name; CORS_ORIGIN is still read for older .env files.
const corsOrigins = (process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "http://localhost:3001")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const notifyRevalidation = createRevalidationNotifier({
  url: process.env.REVALIDATE_URL,
  secret: process.env.REVALIDATE_SECRET,
  timeoutMs: positiveIntegerEnv("REVALIDATE_TIMEOUT_MS", 5000),
});

const app = createApp({
  postsDirectory,
  adminApiKey: process.env.ADMIN_API_KEY,
  corsOrigins,
  defaultAuthor: process.env.DEFAULT_AUTHOR_NAME?.trim() || undefined,
  onPostsChanged: notifyRevalidation,
  writeRateLimit: {
    windowMs: positiveIntegerEnv("WRITE_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    limit: positiveIntegerEnv("WRITE_RATE_LIMIT_MAX", 30),
  },
  trustProxy: trustProxyEnv(process.env.TRUST_PROXY),
});

app.listen(port, () => {
  console.log(`Blog API listening on http://localhost:${port}`);
  console.log(`Markdown posts directory: ${postsDirectory}`);
  console.log(`CORS allowlist: ${corsOrigins.join(", ")}`);
});
