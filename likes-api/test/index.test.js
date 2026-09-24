import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createWorker } from "../src/index.js";

const ORIGIN = "https://wiigg.dev";
const FIRST = "93f2a341-241c-4e78-a780-6357d676773e";
const SECOND = "6a3c78c9-bcfb-42cb-9b6a-fd715b776ee4";
const POSTS = ["first-post", "second-post"];
const migration = readFileSync(new URL("../migrations/0001_likes.sql", import.meta.url), "utf8");

function setup(t, options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  let fetches = 0;
  let time = 0;
  let manifest = () => Response.json(POSTS);
  const rateKeys = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...args);
            },
            execute() {
              const statement = sqlite.prepare(sql);
              if (statement.columns().length) return { success: true, results: statement.all(...args) };
              statement.run(...args);
              return { success: true, results: [] };
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = {
    SITE_ORIGIN: ORIGIN,
    POSTS_URL: `${ORIGIN}/likes.json`,
    LIKES_DB: db,
    LIKES_RATE_LIMITER: {
      async limit({ key }) {
        rateKeys.push(key);
        return { success: true };
      },
    },
  };
  const worker = createWorker({
    now: () => time,
    fetchPosts: async (url, init) => {
      fetches++;
      assert.equal(url, env.POSTS_URL);
      assert.equal(init.cache, "no-store");
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      return manifest(url, init);
    },
    ...options,
  });
  return {
    env, db, sqlite, rateKeys,
    fetches: () => fetches,
    setManifest(value) { manifest = value; },
    advance(ms) { time += ms; },
    async request(method = "GET", { post = POSTS[0], visitor = FIRST, headers = {}, body, path } = {}) {
      const requestHeaders = { Origin: env.SITE_ORIGIN, ...headers };
      if (method === "GET" && visitor) requestHeaders["X-Visitor-ID"] = visitor;
      if (["POST", "DELETE"].includes(method)) {
        if (requestHeaders["Content-Type"] === undefined) requestHeaders["Content-Type"] = "application/json";
        if (requestHeaders["CF-Connecting-IP"] === undefined) requestHeaders["CF-Connecting-IP"] = "192.0.2.1";
        body ??= JSON.stringify({ postId: post, visitorId: visitor });
      }
      for (const [key, value] of Object.entries(requestHeaders)) {
        if (value === null) delete requestHeaders[key];
      }
      const response = await worker.fetch(new Request(`https://likes.example${path ?? `/likes${method === "GET" ? `?post=${encodeURIComponent(post)}` : ""}`}`, {
        method, headers: requestHeaders, ...(body !== undefined && { body, duplex: "half" }),
      }), env);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Vary"), "Origin");
      return response;
    },
  };
}

async function result(response, status = 200) {
  assert.equal(response.status, status);
  return response.json();
}

test("like and undo are idempotent, with isolated posts and visitors", async (t) => {
  const api = setup(t);
  assert.deepEqual(await result(await api.request()), { count: 0, liked: false });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await result(await api.request("POST")), { count: 1, liked: true });
  }
  assert.deepEqual(await result(await api.request("GET", { visitor: SECOND })), { count: 1, liked: false });
  assert.deepEqual(await result(await api.request("POST", { visitor: SECOND })), { count: 2, liked: true });
  assert.deepEqual(await result(await api.request("GET", { visitor: null })), { count: 2, liked: false });
  assert.deepEqual(await result(await api.request("POST", { post: POSTS[1] })), { count: 1, liked: true });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await result(await api.request("DELETE")), { count: 1, liked: false });
  }
  assert.deepEqual(await result(await api.request("GET", { visitor: SECOND })), { count: 1, liked: true });
  assert.deepEqual(await result(await api.request("GET", { post: POSTS[1] })), { count: 1, liked: true });
  assert.equal(api.sqlite.prepare("SELECT COUNT(*) AS count FROM likes").get().count, 2);
});

test("UUID case cannot create duplicate likes", async (t) => {
  const api = setup(t);
  await result(await api.request("POST"));
  assert.deepEqual(await result(await api.request("POST", { visitor: FIRST.toUpperCase() })), { count: 1, liked: true });
  assert.deepEqual(await result(await api.request("DELETE", { visitor: FIRST.toUpperCase() })), { count: 0, liked: false });
});

test("concurrent duplicate requests preserve one like", async (t) => {
  const api = setup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => api.request("POST")));
  for (const response of responses) assert.deepEqual(await result(response), { count: 1, liked: true });
  assert.equal(api.fetches(), 1);
});

test("only exact configured origins receive CORS permission", async (t) => {
  const api = setup(t);
  const allowed = await api.request();
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  for (const origin of ["https://wiigg.dev.evil.example", "https://evil.example", "null", "http://localhost:1313"]) {
    const denied = await api.request("POST", { headers: { Origin: origin } });
    await result(denied, 403);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  }
  await result(await api.request("POST", { headers: { Origin: null } }), 403);
  assert.deepEqual(await result(await api.request("GET", { headers: { Origin: null } })), { count: 0, liked: false });
  api.env.SITE_ORIGIN = "http://localhost:1313";
  const local = await api.request("POST");
  assert.equal(local.headers.get("Access-Control-Allow-Origin"), "http://localhost:1313");
  await result(local);
  await result(await api.request("GET", { headers: { Origin: ORIGIN } }), 403);
});

test("CORS preflight permits only the expected methods and headers without touching services", async (t) => {
  const api = setup(t);
  api.env.LIKES_DB = null;
  const response = await api.request("OPTIONS", { headers: {
    "Access-Control-Request-Method": "DELETE",
    "Access-Control-Request-Headers": "Content-Type, X-Visitor-ID",
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, DELETE, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "content-type, x-visitor-id");
  assert.equal(api.fetches(), 0);
  assert.equal(api.rateKeys.length, 0);
  await result(await api.request("OPTIONS", { headers: { "Access-Control-Request-Method": "PUT" } }), 403);
  await result(await api.request("OPTIONS", { headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization",
  } }), 403);
});

test("invalid input is rejected before manifest or database access", async (t) => {
  const api = setup(t);
  api.env.LIKES_DB = null;
  for (const post of ["", "Uppercase", "-post", "post/path", "x".repeat(101), "a' OR 1=1 --"]) {
    await result(await api.request("GET", { post }), 400);
    await result(await api.request("POST", { post }), 400);
  }
  for (const visitor of ["", "not-a-uuid", FIRST + "x", null]) {
    await result(await api.request("POST", { visitor }), 400);
  }
  await result(await api.request("GET", { visitor: "invalid" }), 400);
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ postId: POSTS[0], visitorId: FIRST, extra: true })]) {
    await result(await api.request("POST", { body }), 400);
  }
  await result(await api.request("GET", { path: "/likes?post=first-post&post=second-post" }), 400);
  await result(await api.request("GET", { path: "/likes?post=first-post&unexpected=1" }), 400);
  await result(await api.request("POST", { path: "/likes?post=first-post" }), 400);
  await result(await api.request("POST", { headers: { "Content-Type": "text/plain" } }), 415);
  assert.equal(api.fetches(), 0);
});

test("oversized declared, actual and streamed bodies are rejected", async (t) => {
  const api = setup(t);
  await result(await api.request("POST", { headers: { "Content-Length": "1025" } }), 413);
  await result(await api.request("POST", { body: " ".repeat(1025) }), 413);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  await result(await api.request("POST", { body }), 413);
  await result(await api.request("GET", { path: "/likes?post=" + "a".repeat(1024) }), 414);
  assert.equal(api.fetches(), 0);
});

test("unknown posts cannot read or insert arbitrary records", async (t) => {
  const api = setup(t);
  for (const method of ["GET", "POST", "DELETE"]) {
    await result(await api.request(method, { post: "not-published" }), 404);
  }
  assert.equal(api.sqlite.prepare("SELECT COUNT(*) AS count FROM likes").get().count, 0);
});

test("rate limits use the Cloudflare IP and stop writes with Retry-After", async (t) => {
  const api = setup(t);
  await result(await api.request("POST"));
  assert.deepEqual(api.rateKeys, ["192.0.2.1"]);
  api.env.LIKES_RATE_LIMITER.limit = async () => ({ success: false });
  for (const method of ["POST", "DELETE"]) {
    const response = await api.request(method);
    assert.equal(response.headers.get("Retry-After"), "60");
    await result(response, 429);
  }
  assert.deepEqual(await result(await api.request()), { count: 1, liked: true });
});

test("missing or failed rate limiting fails closed without database writes", async (t) => {
  const api = setup(t);
  for (const limiter of [null, {}, { limit: async () => ({}) }, { limit: async () => { throw new Error("private internals"); } }]) {
    api.env.LIKES_RATE_LIMITER = limiter;
    assert.deepEqual(await result(await api.request("POST"), 503), { error: "Likes temporarily unavailable" });
  }
  api.env.LIKES_RATE_LIMITER = { limit: async () => ({ success: true }) };
  await result(await api.request("POST", { headers: { "CF-Connecting-IP": null } }), 503);
  assert.equal(api.fetches(), 0);
  assert.equal(api.sqlite.prepare("SELECT COUNT(*) AS count FROM likes").get().count, 0);
});

test("manifest cache expires within five minutes and never serves stale data after failure", async (t) => {
  const api = setup(t);
  await result(await api.request());
  api.setManifest(() => new Response("unavailable", { status: 503 }));
  api.advance(299_999);
  await result(await api.request());
  assert.equal(api.fetches(), 1);
  api.advance(1);
  await result(await api.request("POST"), 503);
  assert.equal(api.fetches(), 2);
  assert.equal(api.sqlite.prepare("SELECT COUNT(*) AS count FROM likes").get().count, 0);
  api.setManifest(() => Response.json([POSTS[1]]));
  await result(await api.request(), 404);
  await result(await api.request("GET", { post: POSTS[1] }));
  assert.equal(api.fetches(), 3);
});

test("manifest failures, malformed data and excessive size fail closed", async (t) => {
  const api = setup(t);
  for (const manifest of [
    () => { throw new Error("upstream secret"); },
    () => new Response("not json"),
    () => Response.json({ posts: POSTS }),
    () => Response.json(["INVALID"]),
    () => Response.json([null]),
    () => Response.json(["a".repeat(65_536)]),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/likes.json" } }),
  ]) {
    api.setManifest(manifest);
    assert.deepEqual(await result(await api.request("POST"), 503), { error: "Likes temporarily unavailable" });
  }
  assert.equal(api.sqlite.prepare("SELECT COUNT(*) AS count FROM likes").get().count, 0);
});

test("manifest requests time out and return safe unavailability", async (t) => {
  const api = setup(t);
  api.setManifest((_url, { signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout not applied")), 4000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  }));
  assert.deepEqual(await result(await api.request(), 503), { error: "Likes temporarily unavailable" });
});

test("database failure and malformed results return safe unavailability", async (t) => {
  const api = setup(t);
  for (const db of [
    null,
    { prepare() { throw new Error("private database details"); } },
    { prepare() { return { bind() { return { first: async () => null }; } }; } },
    { prepare() { return { bind() { return { first: async () => ({ count: -1, liked: 0 }) }; } }; } },
  ]) {
    api.env.LIKES_DB = db;
    assert.deepEqual(await result(await api.request(), 503), { error: "Likes temporarily unavailable" });
  }
  api.env.LIKES_DB = { ...api.db, batch: async () => [{ success: false, error: "private database details" }] };
  assert.deepEqual(await result(await api.request("POST"), 503), { error: "Likes temporarily unavailable" });
});

test("unknown paths and unsupported methods do not reach services", async (t) => {
  const api = setup(t);
  await result(await api.request("GET", { path: "/other" }), 404);
  const response = await api.request("PUT");
  await result(response, 405);
  assert.equal(response.headers.get("Allow"), "GET, POST, DELETE, OPTIONS");
  assert.equal(api.fetches(), 0);
});
