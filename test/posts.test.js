import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";

const adminApiKey = "test-admin-key";
let postsDirectory;
let server;
let baseUrl;

before(async () => {
  postsDirectory = await mkdtemp(path.join(os.tmpdir(), "fieldnotes-api-"));
  await mkdir(postsDirectory, { recursive: true });
  await writeFile(
    path.join(postsDirectory, "first-post.md"),
    `---\ntitle: First post\ndescription: A creative note\ncategory: Creativity\ndate: 2025-03-18\n---\n\nA little bit of writing.\n`,
  );
  await writeFile(
    path.join(postsDirectory, "second-post.md"),
    `---\ntitle: Second post\ndescription: A field note\ncategory: Field notes\ndate: 2025-02-04\n---\n\nAnother little note.\n`,
  );
  server = createApp({ postsDirectory, adminApiKey }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (postsDirectory) await rm(postsDirectory, { recursive: true, force: true });
});

test("lists newest-first summaries and supports search, category, and pagination", async () => {
  const allPosts = await fetch(`${baseUrl}/api/posts`).then((response) => response.json());
  assert.deepEqual(allPosts.data.map((post) => [post.slug, post.number]), [
    ["first-post", 1],
    ["second-post", 2],
  ]);

  const response = await fetch(`${baseUrl}/api/posts?category=Creativity&search=creative&page=1&limit=1`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].slug, "first-post");
  assert.equal(result.data[0].readingTime, 1);
  assert.deepEqual(result.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 });
});

test("returns Markdown and rendered HTML by slug", async () => {
  const response = await fetch(`${baseUrl}/api/posts/first-post`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.match(data.content, /A little bit of writing/);
  assert.match(data.contentHtml, /<p>A little bit of writing\.<\/p>/);
});

test("serves Swagger UI and an OpenAPI contract for every blog endpoint", async () => {
  const uiResponse = await fetch(`${baseUrl}/api-docs/`);
  assert.equal(uiResponse.status, 200);
  assert.match(uiResponse.headers.get("content-type"), /text\/html/);
  assert.match(await uiResponse.text(), /swagger-ui/);

  const specResponse = await fetch(`${baseUrl}/api-docs.json`);
  assert.equal(specResponse.status, 200);
  const spec = await specResponse.json();
  assert.equal(spec.openapi, "3.0.3");
  assert.ok(spec.paths["/api/posts"].get);
  assert.ok(spec.paths["/api/posts"].post.security);
  assert.ok(spec.paths["/api/posts/{slug}"].put);
  assert.ok(spec.paths["/api/posts/{slug}"].delete);
  assert.equal(spec.components.securitySchemes.AdminApiKey.name, "x-admin-api-key");
});

test("requires the admin key for writes and validates post input", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-api-key": adminApiKey },
    body: JSON.stringify({ title: "Incomplete" }),
  });
  assert.equal(invalid.status, 400);
});

test("creates, updates, and deletes Markdown posts", async () => {
  const headers = { "content-type": "application/json", "x-admin-api-key": adminApiKey };
  const created = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "A new note",
      description: "New description",
      category: "Creativity",
      date: "2025-04-01",
      content: "First draft.",
    }),
  });
  assert.equal(created.status, 201);
  const createdPost = (await created.json()).data;
  assert.equal(createdPost.slug, "a-new-note");
  assert.match(await readFile(path.join(postsDirectory, "a-new-note.md"), "utf8"), /title: A new note/);

  const updated = await fetch(`${baseUrl}/api/posts/a-new-note`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      title: "A new note",
      description: "Revised description",
      category: "Field notes",
      date: "2025-04-02",
      content: "Revised draft.",
    }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.description, "Revised description");

  const deleted = await fetch(`${baseUrl}/api/posts/a-new-note`, {
    method: "DELETE",
    headers: { "x-admin-api-key": adminApiKey },
  });
  assert.equal(deleted.status, 204);
  assert.equal(await fetch(`${baseUrl}/api/posts/a-new-note`).then((response) => response.status), 404);
});

test("returns the default author unless frontmatter overrides it", async () => {
  const { data } = await fetch(`${baseUrl}/api/posts/first-post`).then((response) => response.json());
  assert.deepEqual(data.author, { name: "Alex Morgan" });
  assert.equal("authorOverride" in data, false);

  const list = await fetch(`${baseUrl}/api/posts`).then((response) => response.json());
  assert.equal("author" in list.data[0], false);
});

test("notifies the revalidation hook after each write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fieldnotes-hook-"));
  const calls = [];
  const hookServer = createApp({
    postsDirectory: directory,
    adminApiKey,
    defaultAuthor: "Default Writer",
    onPostsChanged: async (tags) => { calls.push(tags); },
  }).listen(0);
  await new Promise((resolve) => hookServer.once("listening", resolve));
  const url = `http://127.0.0.1:${hookServer.address().port}`;
  const headers = { "content-type": "application/json", "x-admin-api-key": adminApiKey };
  const body = { title: "Hooked", description: "d", category: "c", date: "2025-05-01", content: "x" };

  try {
    const created = await fetch(`${url}/api/posts`, { method: "POST", headers, body: JSON.stringify({ ...body, author: "Guest Writer" }) });
    assert.equal((await created.json()).data.author.name, "Guest Writer");
    const updated = await fetch(`${url}/api/posts/hooked`, { method: "PUT", headers, body: JSON.stringify(body) });
    assert.equal((await updated.json()).data.author.name, "Default Writer");
    await fetch(`${url}/api/posts/hooked`, { method: "DELETE", headers });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [
      ["posts", "post:hooked"],
      ["posts", "post:hooked"],
      ["posts", "post:hooked"],
    ]);
  } finally {
    await new Promise((resolve) => hookServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limits write endpoints but not reads", async () => {
  const limitedServer = createApp({ postsDirectory, adminApiKey, writeRateLimit: { windowMs: 60_000, limit: 2 } }).listen(0);
  await new Promise((resolve) => limitedServer.once("listening", resolve));
  const url = `http://127.0.0.1:${limitedServer.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await fetch(`${url}/api/posts/missing-post`, { method: "DELETE" })).status);
    }
    assert.deepEqual(statuses, [401, 401, 429]);
    assert.equal((await fetch(`${url}/api/posts`)).status, 200);
  } finally {
    await new Promise((resolve) => limitedServer.close(resolve));
  }
});

test("rejects browser origins outside the allowlist", async () => {
  const blocked = await fetch(`${baseUrl}/api/posts`, { headers: { origin: "https://evil.example" } });
  assert.equal(blocked.status, 403);
  const allowed = await fetch(`${baseUrl}/api/posts`, { headers: { origin: "http://localhost:3001" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3001");
});
