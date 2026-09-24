const POST_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 1024;
const MANIFEST_LIMIT = 64 * 1024;
const MANIFEST_TTL = 5 * 60 * 1000;
const MANIFEST_TIMEOUT = 3000;
const METHODS = ["GET", "POST", "DELETE"];
const ALLOWED_HEADERS = ["content-type", "x-visitor-id"];
const STATUS_SQL = `
  SELECT COUNT(*) AS count, COALESCE(MAX(visitor_id = ?), 0) AS liked
  FROM likes WHERE post_id = ?
`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readLimited(stream, limit) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function siteOrigin(env) {
  const url = new URL(env.SITE_ORIGIN);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== env.SITE_ORIGIN || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("Invalid site origin");
  }
  return url.origin;
}

function visitorId(value) {
  if (typeof value !== "string" || !VISITOR_ID.test(value)) {
    throw new HttpError(400, "Invalid visitor ID");
  }
  return value.toLowerCase();
}

function postId(value) {
  if (typeof value !== "string" || !POST_ID.test(value)) {
    throw new HttpError(400, "Invalid post ID");
  }
  return value;
}

function statusResponse(row) {
  if (!row || !Number.isSafeInteger(row.count) || row.count < 0 || ![0, 1].includes(row.liked)) {
    throw new Error("Invalid database result");
  }
  return { count: row.count, liked: row.liked === 1 };
}

export function createWorker({ fetchPosts = fetch, now = Date.now } = {}) {
  let manifestCache;
  let manifestLoading;

  async function publishedPosts(url) {
    if (manifestCache?.url === url && now() < manifestCache.expires) return manifestCache.posts;
    if (manifestLoading?.url === url) return manifestLoading.promise;

    const promise = (async () => {
      const response = await fetchPosts(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT),
        redirect: "manual",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Post manifest unavailable");
      const ids = JSON.parse(await readLimited(response.body, MANIFEST_LIMIT));
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !POST_ID.test(id))) {
        throw new Error("Invalid post manifest");
      }
      const posts = new Set(ids);
      manifestCache = { url, posts, expires: now() + MANIFEST_TTL };
      return posts;
    })();
    manifestLoading = { url, promise };
    try {
      return await promise;
    } finally {
      if (manifestLoading?.promise === promise) manifestLoading = undefined;
    }
  }

  return {
    async fetch(request, env) {
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Vary": "Origin",
        "X-Content-Type-Options": "nosniff",
      });
      const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

      try {
        const origin = request.headers.get("Origin");
        const allowedOrigin = siteOrigin(env);
        if (origin && origin !== allowedOrigin) throw new HttpError(403, "Origin not allowed");
        if (origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", allowedOrigin);

        if (request.url.length > BODY_LIMIT) throw new HttpError(414, "URL too long");
        const url = new URL(request.url);
        if (url.pathname !== "/likes") throw new HttpError(404, "Not found");

        if (request.method === "OPTIONS") {
          if (!origin) throw new HttpError(403, "Origin required");
          const method = request.headers.get("Access-Control-Request-Method");
          const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
            .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
          if (!METHODS.includes(method) || requestedHeaders.some((header) => !ALLOWED_HEADERS.includes(header))) {
            throw new HttpError(403, "Request not allowed");
          }
          headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
          headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
          headers.set("Access-Control-Max-Age", "600");
          headers.delete("Content-Type");
          return new Response(null, { status: 204, headers });
        }

        if (!METHODS.includes(request.method)) {
          headers.set("Allow", "GET, POST, DELETE, OPTIONS");
          throw new HttpError(405, "Method not allowed");
        }

        let post;
        let visitor = null;
        if (request.method === "GET") {
          if (url.searchParams.getAll("post").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "post")) {
            throw new HttpError(400, "A single post is required");
          }
          post = postId(url.searchParams.get("post"));
          const suppliedVisitor = request.headers.get("X-Visitor-ID");
          if (suppliedVisitor !== null) visitor = visitorId(suppliedVisitor);
        } else {
          if (!origin) throw new HttpError(403, "Origin required");
          if (url.search) throw new HttpError(400, "Unexpected query parameters");
          if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            throw new HttpError(415, "JSON required");
          }
          const length = request.headers.get("Content-Length");
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
            throw new HttpError(413, "Request too large");
          }
          let body;
          try {
            body = JSON.parse(await readLimited(request.body, BODY_LIMIT));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(400, "Invalid JSON");
          }
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["postId", "visitorId"].includes(key))) {
            throw new HttpError(400, "Invalid request");
          }
          post = postId(body.postId);
          visitor = visitorId(body.visitorId);

          const ip = request.headers.get("CF-Connecting-IP");
          if (!ip || !env.LIKES_RATE_LIMITER?.limit) throw new Error("Rate limiter unavailable");
          const result = await env.LIKES_RATE_LIMITER.limit({ key: ip });
          if (typeof result?.success !== "boolean") throw new Error("Rate limiter unavailable");
          if (!result.success) {
            headers.set("Retry-After", "60");
            throw new HttpError(429, "Too many requests");
          }
        }

        let posts;
        try {
          posts = await publishedPosts(env.POSTS_URL);
        } catch {
          throw new Error("Post manifest unavailable");
        }
        if (!posts.has(post)) throw new HttpError(404, "Post not found");

        const query = env.LIKES_DB.prepare(STATUS_SQL).bind(visitor, post);
        if (request.method === "GET") return respond(statusResponse(await query.first()));

        const sql = request.method === "POST"
          ? "INSERT INTO likes (post_id, visitor_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
          : "DELETE FROM likes WHERE post_id = ? AND visitor_id = ?";
        // D1 batches are transactional: each response includes the state after its own write.
        const results = await env.LIKES_DB.batch([
          env.LIKES_DB.prepare(sql).bind(post, visitor), query,
        ]);
        if (results.some((result) => !result.success)) throw new Error("Database unavailable");
        return respond(statusResponse(results[1]?.results?.[0]));
      } catch (error) {
        if (error instanceof HttpError) return respond({ error: error.message }, error.status);
        return respond({ error: "Likes temporarily unavailable" }, 503);
      }
    },
  };
}

export default createWorker();
