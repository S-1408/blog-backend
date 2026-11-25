const postFields = {
  title: { type: "string", maxLength: 300, example: "A thoughtful title" },
  description: { type: "string", maxLength: 300, example: "A short summary for the article." },
  category: { type: "string", maxLength: 300, example: "Creativity" },
  date: { type: "string", format: "date", example: "2025-04-01" },
  content: { type: "string", maxLength: 500000, description: "Markdown body of the post." },
  author: {
    type: "string",
    maxLength: 120,
    description: "Optional author name. When omitted, the server's DEFAULT_AUTHOR_NAME is used.",
    example: "Alex Morgan",
  },
};

// List responses omit the Markdown body and author.
const { content: _content, author: _author, ...summaryFields } = postFields;

const tooManyRequests = {
  description: "Too many write requests from this client.",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Fieldnotes Blog API",
    version: "1.0.0",
    description: "Browse and manage the Markdown posts used by the Fieldnotes blog.",
  },
  servers: [{ url: "/", description: "Current API server" }],
  tags: [
    { name: "Posts", description: "Browse and manage blog posts." },
    { name: "Categories", description: "Browse post categories." },
    { name: "System", description: "API status." },
  ],
  components: {
    securitySchemes: {
      AdminApiKey: {
        type: "apiKey",
        in: "header",
        name: "x-admin-api-key",
        description: "Set this to the ADMIN_API_KEY configured on the API server.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", example: "Post not found." },
          details: { type: "array", items: { type: "string" } },
        },
      },
      PostSummary: {
        type: "object",
        required: ["slug", "title", "description", "category", "isoDate", "date", "readingTime", "number"],
        properties: {
          slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", example: "making-room-for-the-work" },
          ...summaryFields,
          date: { type: "string", example: "Mar 18, 2025" },
          isoDate: { type: "string", format: "date-time", example: "2025-04-01T00:00:00.000Z" },
          readingTime: { type: "integer", minimum: 1, example: 3 },
          number: { type: "integer", minimum: 1, example: 1 },
        },
      },
      Post: {
        allOf: [
          { $ref: "#/components/schemas/PostSummary" },
          {
            type: "object",
            required: ["content", "contentHtml", "author"],
            properties: {
              author: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", example: "Alex Morgan" } },
              },
              content: { type: "string", description: "Original Markdown source." },
              contentHtml: { type: "string", description: "Server-rendered HTML generated from the Markdown." },
            },
          },
        ],
      },
      CreatePost: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "category", "date", "content"],
        properties: {
          ...postFields,
          slug: {
            type: "string",
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            description: "Optional URL slug; generated from the title if omitted.",
            example: "a-thoughtful-title",
          },
        },
      },
      UpdatePost: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "category", "date", "content"],
        properties: postFields,
      },
      PostResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Post" } },
      },
      PostList: {
        type: "object",
        required: ["data", "pagination"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/PostSummary" } },
          pagination: {
            type: "object",
            required: ["page", "limit", "total", "totalPages"],
            properties: {
              page: { type: "integer", example: 1 },
              limit: { type: "integer", example: 20 },
              total: { type: "integer", example: 4 },
              totalPages: { type: "integer", example: 1 },
            },
          },
        },
      },
    },
    parameters: {
      Slug: {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        example: "the-art-of-noticing",
      },
    },
  },
  paths: {
    "/api/health": {
      get: {
        tags: ["System"],
        summary: "Check API health",
        operationId: "getHealth",
        responses: {
          200: {
            description: "API is available.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", example: "ok" } },
                },
              },
            },
          },
        },
      },
    },
    "/api/posts": {
      get: {
        tags: ["Posts"],
        summary: "List, search, or filter posts",
        operationId: "listPosts",
        parameters: [
          { name: "category", in: "query", schema: { type: "string" }, description: "Filter to an exact category." },
          { name: "search", in: "query", schema: { type: "string" }, description: "Search post title, description, and category." },
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: {
          200: {
            description: "Newest-first post summaries and pagination.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PostList" } } },
          },
          400: {
            description: "Invalid pagination values.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      post: {
        tags: ["Posts"],
        summary: "Create a post",
        operationId: "createPost",
        security: [{ AdminApiKey: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePost" } } },
        },
        responses: {
          201: {
            description: "Post created.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PostResponse" } } },
          },
          400: { description: "Invalid post data.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Missing or invalid admin API key.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "A post with this slug already exists.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: tooManyRequests,
          503: { description: "Write access is disabled until an admin key is configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/posts/{slug}": {
      parameters: [{ $ref: "#/components/parameters/Slug" }],
      get: {
        tags: ["Posts"],
        summary: "Get a post by slug",
        operationId: "getPost",
        responses: {
          200: {
            description: "Post including Markdown and rendered HTML.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PostResponse" } } },
          },
          400: { description: "Invalid slug.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Post not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["Posts"],
        summary: "Replace a post's editable fields",
        operationId: "updatePost",
        security: [{ AdminApiKey: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UpdatePost" } } },
        },
        responses: {
          200: { description: "Post updated.", content: { "application/json": { schema: { $ref: "#/components/schemas/PostResponse" } } } },
          400: { description: "Invalid slug or post data.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Missing or invalid admin API key.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Post not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: tooManyRequests,
          503: { description: "Write access is disabled until an admin key is configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Posts"],
        summary: "Delete a post",
        operationId: "deletePost",
        security: [{ AdminApiKey: [] }],
        responses: {
          204: { description: "Post deleted." },
          400: { description: "Invalid slug.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          401: { description: "Missing or invalid admin API key.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Post not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: tooManyRequests,
          503: { description: "Write access is disabled until an admin key is configured.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/categories": {
      get: {
        tags: ["Categories"],
        summary: "List post categories",
        operationId: "listCategories",
        responses: {
          200: {
            description: "Unique post categories.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: { data: { type: "array", items: { type: "string" }, example: ["Creativity", "Field notes"] } },
                },
              },
            },
          },
        },
      },
    },
    "/api-docs.json": {
      get: {
        tags: ["System"],
        summary: "Get the OpenAPI specification",
        operationId: "getOpenApiSpec",
        responses: { 200: { description: "OpenAPI 3.0 specification in JSON format." } },
      },
    },
  },
};

export default openApiSpec;
