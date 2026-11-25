import { createHash, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { ApiError, createPostStore, slugFromTitle, validatePostInput } from "./posts.js";
import openApiSpec from "./openapi.js";
import { POSTS_TAG, postTag } from "./revalidate.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireAdminKey(configuredKey) {
  return (req, res, next) => {
    if (!configuredKey) {
      return res.status(503).json({ error: "Write endpoints are disabled until ADMIN_API_KEY is configured." });
    }
    const providedKey = req.get("x-admin-api-key");
    if (!providedKey) {
      return res.status(401).json({ error: "Provide the x-admin-api-key header." });
    }
    const expectedHash = createHash("sha256").update(configuredKey).digest();
    const providedHash = createHash("sha256").update(providedKey).digest();
    if (!timingSafeEqual(expectedHash, providedHash)) {
      return res.status(401).json({ error: "Invalid admin API key." });
    }
    next();
  };
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, "Pagination values must be positive integers.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ApiError(400, `Pagination value must not exceed ${maximum}.`);
  }
  return parsed;
}

function createWriteLimiter({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many write requests. Try again later." });
    },
  });
}

export function createApp({
  postsDirectory,
  adminApiKey,
  corsOrigins = ["http://localhost:3001"],
  defaultAuthor,
  onPostsChanged = async () => {},
  writeRateLimit = { windowMs: 15 * 60 * 1000, limit: 30 },
  trustProxy = false,
}) {
  if (!postsDirectory) throw new Error("postsDirectory is required.");
  const postStore = createPostStore(postsDirectory, { defaultAuthor });
  const app = express();
  app.disable("x-powered-by");
  // Needed behind a reverse proxy so rate limiting sees the real client IP.
  app.set("trust proxy", trustProxy);

  // Fire-and-forget: the write already succeeded, so a slow or failing webhook must not delay or fail it.
  const notifyChanged = (slug) => {
    Promise.resolve(onPostsChanged([POSTS_TAG, postTag(slug)])).catch((error) => {
      console.error("Revalidation notifier threw:", error);
    });
  };
  app.get("/", (_req, res) => {
    res.redirect("/api-docs");
  });
  app.get("/api-docs.json", (_req, res) => {
    res.json(openApiSpec);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: "Fieldnotes Blog API — Swagger UI",
    explorer: true,
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) return callback(null, true);
      return callback(new ApiError(403, "Origin is not allowed by CORS."));
    },
  }));
  app.use(express.json({ limit: "600kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/posts", async (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const page = positiveInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = positiveInteger(req.query.limit, 20, 100);
    res.json(await postStore.list({ category, search, page, limit }));
  });

  app.get("/api/categories", async (_req, res) => {
    res.json({ data: await postStore.categories() });
  });

  app.get("/api/posts/:slug", async (req, res) => {
    if (!slugPattern.test(req.params.slug)) {
      throw new ApiError(400, "Slug must contain lowercase letters, numbers, and single hyphens.");
    }
    const post = await postStore.get(req.params.slug);
    if (!post) throw new ApiError(404, "Post not found.");
    res.json({ data: post });
  });

  // Rate limiting runs before the key check so it also slows down key guessing.
  const writeLimiter = createWriteLimiter(writeRateLimit);
  const adminOnly = [writeLimiter, requireAdminKey(adminApiKey)];

  app.post("/api/posts", adminOnly, async (req, res) => {
    const input = validatePostInput(req.body, { allowSlug: true });
    if (!input.slug) input.slug = slugFromTitle(input.title);
    const post = await postStore.create(input);
    res.status(201).json({ data: post });
    notifyChanged(post.slug);
  });

  app.put("/api/posts/:slug", adminOnly, async (req, res) => {
    if (!slugPattern.test(req.params.slug)) {
      throw new ApiError(400, "Slug must contain lowercase letters, numbers, and single hyphens.");
    }
    const input = validatePostInput(req.body);
    const post = await postStore.update(req.params.slug, input);
    if (!post) throw new ApiError(404, "Post not found.");
    res.json({ data: post });
    notifyChanged(post.slug);
  });

  app.delete("/api/posts/:slug", adminOnly, async (req, res) => {
    if (!slugPattern.test(req.params.slug)) {
      throw new ApiError(400, "Slug must contain lowercase letters, numbers, and single hyphens.");
    }
    const deleted = await postStore.delete(req.params.slug);
    if (!deleted) throw new ApiError(404, "Post not found.");
    res.status(204).end();
    notifyChanged(req.params.slug);
  });

  app.use((req, _res, next) => {
    next(new ApiError(404, `Route not found: ${req.method} ${req.path}`));
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ error: "Request body must contain valid JSON." });
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    return res.status(status).json({
      error: status >= 500 ? "Internal server error." : error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  });

  return app;
}
