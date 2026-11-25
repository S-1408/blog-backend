# Fieldnotes Blog API

Standalone Node.js API for the Next.js Fieldnotes blog (`../blog-app`). It owns the Markdown posts in `content/posts/`, and the blog reads everything through this API. After every create, update or delete, it calls the blog's revalidation webhook so changes show up immediately. See the blog README for running both apps together.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `ADMIN_API_KEY` in `.env` to a long, random secret before using any write endpoint. All settings are documented in `.env.example`:

| Variable | Purpose |
| --- | --- |
| `ADMIN_API_KEY` | Required for writes (`x-admin-api-key` header) |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist for browsers (default `http://localhost:3001`). `CORS_ORIGIN` is still accepted. Server-side requests with no `Origin` header are always allowed. |
| `POSTS_DIR` | Markdown directory (default `./content/posts`) |
| `DEFAULT_AUTHOR_NAME` | Author for posts without an `author` frontmatter field |
| `REVALIDATE_URL`, `REVALIDATE_SECRET` | The blog's `/api/revalidate` webhook and its shared secret. If either is unset, the webhook is disabled and a warning is logged. |
| `WRITE_RATE_LIMIT_WINDOW_MS`, `WRITE_RATE_LIMIT_MAX` | Per-IP limit on POST/PUT/DELETE (default 30 per 15 minutes). Over the limit, the API returns `429`. |
| `TRUST_PROXY` | Set behind a reverse proxy (e.g. `1`) so rate limiting sees real client IPs |

Start the API:

```powershell
npm run dev
```

The API listens on `http://localhost:4000` by default. `npm test` runs the API tests, `npm run lint` runs ESLint, and `npm run check` runs both.

## Interactive API docs

Start the API, then open [http://localhost:4000/api-docs](http://localhost:4000/api-docs) to explore and test every endpoint in Swagger UI. The raw OpenAPI JSON is available at [http://localhost:4000/api-docs.json](http://localhost:4000/api-docs.json).

To test write operations, select **Authorize** in Swagger UI and enter the value of `ADMIN_API_KEY` (without a prefix). Read-only endpoints work without authorization.

## Endpoints

All responses use JSON except `DELETE`, which returns `204 No Content`.

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Health status |
| `GET` | `/api/posts` | Public | Newest-first post summaries |
| `GET` | `/api/posts/:slug` | Public | One post, with Markdown and rendered HTML |
| `GET` | `/api/categories` | Public | Categories used by posts |
| `POST` | `/api/posts` | Admin | Create a Markdown post |
| `PUT` | `/api/posts/:slug` | Admin | Replace a post's editable fields |
| `DELETE` | `/api/posts/:slug` | Admin | Delete a Markdown post |

List queries support `category`, `search`, `page` (default `1`), and `limit` (default `20`, maximum `100`). A list response has `{ "data": [], "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } }`. Post responses include `slug`, `title`, `description`, `category`, `isoDate`, `date`, `readingTime`, `number`, `content`, and `contentHtml`, matching the frontend's post fields. Single-post responses also include `author: { name }`. The blog validates every response against the zod schemas in `blog-app/lib/contracts`.

Write requests must send `x-admin-api-key: <ADMIN_API_KEY>` and a JSON object with `title`, `description`, `category`, `date` (`YYYY-MM-DD`), and `content`, plus an optional `author`. `POST` optionally accepts a lowercase hyphenated `slug`; otherwise it is generated from the title. Slugs cannot be changed through `PUT`. Because `PUT` replaces the editable fields, omitting `author` resets it to the default. Write endpoints are rate limited. After a successful write, the API notifies the blog with the cache tags `posts` and `post:<slug>`. A failed webhook is logged and doesn't fail the write.

Example:

```powershell
Invoke-RestMethod http://localhost:4000/api/posts
Invoke-RestMethod -Method Post http://localhost:4000/api/posts `
  -Headers @{ "x-admin-api-key" = "your-configured-key" } `
  -ContentType "application/json" `
  -Body '{"title":"A new note","description":"A short summary","category":"Creativity","date":"2025-04-01","content":"The Markdown body."}'
```
