const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../assets/js/like-counts.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (count) => ({ ok: true, json: async () => ({ count, liked: false }) });

function countElement(postId) {
  const number = { textContent: "" };
  const label = { textContent: "Like count unavailable." };
  return {
    dataset: { postId, endpoint: "https://likes.example.test/" },
    attributes: { title: "Like count unavailable" },
    number,
    label,
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return selector === "[data-count-number]" ? number : label; },
  };
}

function harness({ posts = [], replies = {}, endpoint } = {}) {
  const elements = posts.map(countElement);
  if (endpoint !== undefined) elements.forEach((element) => { element.dataset.endpoint = endpoint; });
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let storageAccesses = 0;
  const blockedStorage = () => {
    storageAccesses += 1;
    throw new Error("Public counts must not access browser identity storage");
  };

  vm.runInNewContext(source, {
    document: { querySelectorAll: () => elements },
    get localStorage() { return blockedStorage(); },
    get sessionStorage() { return blockedStorage(); },
    URL,
    AbortController,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const parsed = new URL(url);
      calls.push({ url: parsed, ...options });
      const next = replies[parsed.searchParams.get("post")];
      if (next instanceof Error) throw next;
      assert.notEqual(next, undefined, "Unexpected post request");
      return typeof next === "function" ? next(options) : next;
    },
  });

  return { elements, calls, timers, get storageAccesses() { return storageAccesses; } };
}

test("independent posts load separately using public GET requests only", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const ui = harness({ posts: ["first-post", "second-post"], replies: {
    "first-post": () => first,
    "second-post": response(27),
  } });
  assert.ok(ui.elements.every(({ number }) => number.textContent === ""));
  await flush();
  assert.equal(ui.elements[0].number.textContent, "");
  assert.equal(ui.elements[1].number.textContent, "27");
  resolveFirst(response(1));
  await flush();
  assert.equal(ui.elements[0].number.textContent, "1");
  assert.equal(ui.elements[0].label.textContent, "1 like");
  assert.equal(ui.calls.length, 2);
  for (const call of ui.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.credentials, "omit");
    assert.equal(call.cache, "no-store");
    assert.deepEqual(Object.keys(call.headers), ["Accept"]);
    assert.equal(call.body, undefined);
    assert.equal(call.url.origin, "https://likes.example.test");
    assert.equal(call.url.pathname, "/likes");
  }
  assert.equal(ui.storageAccesses, 0);
  assert.equal(ui.timers.size, 0);
});

test("repeated appearances of one post share a request and receive the same count", async () => {
  const ui = harness({ posts: ["same-post", "other-post", "same-post"], replies: {
    "same-post": response(8),
    "other-post": response(42),
  } });
  await flush();
  assert.equal(ui.calls.length, 2);
  assert.deepEqual(ui.elements.map(({ number }) => number.textContent), ["8", "42", "8"]);
});

test("zero is displayed only after a successful response", async () => {
  const ui = harness({ posts: ["zero-post"], replies: { "zero-post": response(0) } });
  assert.equal(ui.elements[0].number.textContent, "");
  await flush();
  assert.equal(ui.elements[0].number.textContent, "0");
  assert.equal(ui.elements[0].label.textContent, "0 likes");
});

test("network and HTTP failures stay blank and do not prevent other counts loading", async () => {
  const ui = harness({ posts: ["offline", "unavailable", "available"], replies: {
    offline: new Error("Backend details"),
    unavailable: { ok: false },
    available: response(12),
  } });
  await flush();
  for (const element of ui.elements.slice(0, 2)) {
    assert.equal(element.number.textContent, "");
    assert.equal(element.label.textContent, "Like count unavailable.");
    assert.equal(element.attributes.title, "Like count unavailable");
  }
  assert.equal(ui.elements[2].number.textContent, "12");
  assert.equal(ui.timers.size, 0);
});

test("malformed counts never reach the visible number", async () => {
  for (const count of [-1, 1.5, "12", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const ui = harness({ posts: ["post"], replies: { post: response(count) } });
    await flush();
    assert.equal(ui.elements[0].number.textContent, "");
    assert.equal(ui.elements[0].label.textContent, "Like count unavailable.");
  }
  const ui = harness({ posts: ["post"], replies: { post: { ok: true, json: async () => null } } });
  await flush();
  assert.equal(ui.elements[0].number.textContent, "");
});

test("large totals are compact visually with the exact count accessible", async () => {
  const ui = harness({ posts: ["small", "large"], replies: {
    small: response(9999),
    large: response(123456),
  } });
  await flush();
  assert.equal(ui.elements[0].number.textContent, "9,999");
  assert.equal(ui.elements[1].number.textContent, "123.5k");
  assert.equal(ui.elements[1].label.textContent, "123,456 likes");
  assert.equal(ui.elements[1].attributes.title, "123,456 likes");
});

test("hung requests abort without inventing a count", async () => {
  const ui = harness({ posts: ["slow"], replies: {
    slow: (options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    }),
  } });
  for (const callback of ui.timers.values()) callback();
  await flush();
  assert.equal(ui.calls[0].signal.aborted, true);
  assert.equal(ui.elements[0].number.textContent, "");
  assert.equal(ui.elements[0].label.textContent, "Like count unavailable.");
  assert.equal(ui.timers.size, 0);
});

test("pages without counts and invalid endpoints make no requests", async () => {
  const empty = harness();
  const invalid = harness({ posts: ["post"], endpoint: "not a URL" });
  await flush();
  assert.equal(empty.calls.length, 0);
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.elements[0].number.textContent, "");
  assert.equal(empty.storageAccesses + invalid.storageAccesses, 0);
});
