import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { remark } from "remark";
import html from "remark-html";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const requiredFields = ["title", "description", "category", "date", "content"];
const optionalFields = ["author"];

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function slugFromTitle(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function validatePostInput(value, { allowSlug = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object.");
  }

  const allowedFields = [...requiredFields, ...optionalFields, ...(allowSlug ? ["slug"] : [])];
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    throw new ApiError(400, "Request contains unsupported fields.", unknownFields);
  }

  const errors = [];
  for (const field of requiredFields) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      errors.push(`${field} must be a non-empty string.`);
    }
  }

  for (const field of ["title", "description", "category"]) {
    if (typeof value[field] === "string" && value[field].length > 300) {
      errors.push(`${field} must be 300 characters or fewer.`);
    }
  }

  if (typeof value.content === "string" && value.content.length > 500_000) {
    errors.push("content must be 500,000 characters or fewer.");
  }

  if (typeof value.date === "string" && !isValidDate(value.date)) {
    errors.push("date must be a valid ISO calendar date in YYYY-MM-DD format.");
  }

  if (value.author !== undefined &&
      (typeof value.author !== "string" || !value.author.trim() || value.author.length > 120)) {
    errors.push("author must be a non-empty string of 120 characters or fewer.");
  }

  if (allowSlug && value.slug !== undefined &&
      (typeof value.slug !== "string" || !slugPattern.test(value.slug))) {
    errors.push("slug must contain lowercase letters, numbers, and single hyphens.");
  }

  if (errors.length > 0) {
    throw new ApiError(400, "Post validation failed.", errors);
  }

  return {
    title: value.title.trim(),
    description: value.description.trim(),
    category: value.category.trim(),
    date: value.date,
    content: value.content,
    ...(value.author === undefined ? {} : { author: value.author.trim() }),
    ...(value.slug === undefined ? {} : { slug: value.slug }),
  };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function frontmatterDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return "";
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(isoDate));
}

function toPost(slug, metadata, content, number, defaultAuthor) {
  const date = frontmatterDate(metadata.date);
  const fields = {
    title: metadata.title,
    description: metadata.description,
    category: metadata.category,
    date,
  };
  const errors = [];
  for (const field of ["title", "description", "category"]) {
    if (typeof fields[field] !== "string" || !fields[field].trim()) {
      errors.push(`${field} is missing from the post frontmatter.`);
    }
  }
  if (!isValidDate(date)) errors.push("date must use YYYY-MM-DD in the post frontmatter.");
  if (metadata.author !== undefined && (typeof metadata.author !== "string" || !metadata.author.trim())) {
    errors.push("author must be a non-empty string when present in the post frontmatter.");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid frontmatter in "${slug}": ${errors.join(" ")}`);
  }

  const isoDate = new Date(`${date}T00:00:00.000Z`).toISOString();
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  return {
    slug,
    title: fields.title,
    description: fields.description,
    category: fields.category,
    isoDate,
    date: formatDate(isoDate),
    readingTime: Math.max(1, Math.ceil(wordCount / 210)),
    number,
    author: { name: metadata.author?.trim() || defaultAuthor },
    // Raw frontmatter value, so updates don't persist the default author into the file.
    authorOverride: metadata.author?.trim() || undefined,
    content,
  };
}

function serializePost(post) {
  const { title, description, category, date, author } = post;
  return matter.stringify(post.content, {
    title,
    description,
    category,
    date,
    ...(typeof author === "string" ? { author } : {}),
  });
}

function toPublicPost({ authorOverride: _authorOverride, ...post }) {
  return post;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createPostStore(postsDirectory, { defaultAuthor = "Alex Morgan" } = {}) {
  async function getRawPost(slug) {
    if (!slugPattern.test(slug)) return null;
    const filePath = path.join(postsDirectory, `${slug}.md`);
    if (!(await exists(filePath))) return null;

    const source = await readFile(filePath, "utf8");
    const parsed = matter(source);
    return toPost(slug, parsed.data, parsed.content, 0, defaultAuthor);
  }

  async function allPosts() {
    await mkdir(postsDirectory, { recursive: true });
    const fileNames = await readdir(postsDirectory);
    const posts = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".md")) continue;
      const slug = fileName.slice(0, -3);
      if (!slugPattern.test(slug)) continue;
      const post = await getRawPost(slug);
      if (post) posts.push(post);
    }
    return posts
      .sort((a, b) => b.isoDate.localeCompare(a.isoDate) || a.slug.localeCompare(b.slug))
      .map((post, index) => ({ ...post, number: index + 1 }));
  }

  async function addHtml(post) {
    const processed = await remark().use(html).process(post.content);
    return { ...toPublicPost(post), contentHtml: processed.toString() };
  }

  async function writeUpdate(slug, post) {
    const destination = path.join(postsDirectory, `${slug}.md`);
    const temporary = path.join(postsDirectory, `.${slug}.${randomUUID()}.tmp`);
    await writeFile(temporary, serializePost(post), { flag: "wx" });
    try {
      await rename(temporary, destination);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") console.error("Could not remove temporary post file:", cleanupError);
      }
      throw error;
    }
  }

  return {
    async list({ category, search, page, limit }) {
      const posts = await allPosts();
      const filtered = posts.filter((post) =>
        (!category || post.category === category) &&
        (!search || `${post.title} ${post.description} ${post.category}`.toLowerCase().includes(search.toLowerCase()))
      );
      const start = (page - 1) * limit;
      return {
        data: filtered.slice(start, start + limit).map(({ content: _content, author: _author, authorOverride: _authorOverride, ...summary }) => summary),
        pagination: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
        },
      };
    },

    async categories() {
      const posts = await allPosts();
      return [...new Set(posts.map((post) => post.category))].sort((a, b) => a.localeCompare(b));
    },

    async get(slug) {
      const posts = await allPosts();
      const post = posts.find((item) => item.slug === slug);
      return post ? addHtml(post) : null;
    },

    async create(input) {
      const slug = input.slug ?? slugFromTitle(input.title);
      if (!slugPattern.test(slug)) {
        throw new ApiError(400, "Could not create a valid slug from the title; provide a slug.");
      }
      await mkdir(postsDirectory, { recursive: true });
      const filePath = path.join(postsDirectory, `${slug}.md`);
      try {
        await writeFile(filePath, serializePost({ ...input, date: input.date }), { flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") throw new ApiError(409, `A post with slug "${slug}" already exists.`);
        throw error;
      }
      return this.get(slug);
    },

    async update(slug, input) {
      const current = await getRawPost(slug);
      if (!current) return null;
      // PUT replaces the editable fields: omitting `author` reverts to the default author.
      const { author: _resolvedAuthor, authorOverride: _authorOverride, ...stored } = current;
      await writeUpdate(slug, { ...stored, ...input, slug });
      return this.get(slug);
    },

    async delete(slug) {
      const filePath = path.join(postsDirectory, `${slug}.md`);
      try {
        await unlink(filePath);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
