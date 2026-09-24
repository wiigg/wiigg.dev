const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../assets/js/likes.js"), "utf8");
const visitorId = "29a67f4d-c745-4918-97bb-77f11629a1c8";
const storageKey = "wiigg.likes.visitorId";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (count, liked) => ({ ok: true, json: async () => ({ count, liked }) });

function element() {
  const handlers = {};
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { handlers[name] = callback; },
    click() { handlers.click?.(); },
  };
}

function storage(initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      if (blocked) throw new Error("Storage blocked");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (blocked) throw new Error("Storage blocked");
      values.set(key, value);
    },
  };
}

function harness({ replies = [], savedId, localBlocked = false, sessionBlocked = false, sessionId } = {}) {
  const button = element();
  const count = element();
  const status = element();
  const retry = element();
  const children = {
    ".post-likes__button": button,
    "[data-like-count]": count,
    ".post-likes__status": status,
    ".post-likes__retry": retry,
  };
  const widget = {
    hidden: true,
    dataset: { postId: "the-questions-we-ask", endpoint: "https://likes.example.test/" },
    querySelector: (selector) => children[selector],
  };
  const local = storage(savedId ? { [storageKey]: savedId } : {}, localBlocked);
  const session = storage(sessionId ? { [storageKey]: sessionId } : {}, sessionBlocked);
  const calls = [];
  const timers = new Map();
  let generatedIds = 0;
  let nextTimer = 0;

  vm.runInNewContext(source, {
    document: { querySelector: () => widget },
    localStorage: local,
    sessionStorage: session,
    URL,
    AbortController,
    crypto: { randomUUID() { generatedIds += 1; return visitorId; } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      calls.push({ url: new URL(url), ...options });
      assert.ok(replies.length, "Unexpected request");
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(options) : next;
    },
  });

  return {
    widget, button, count, status, retry, calls, local, session, timers,
    get generatedIds() { return generatedIds; },
  };
}

test("first visit reads the public count without creating an identity", async () => {
  const ui = harness({ replies: [response(12, false)] });
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.count.hidden, true);
  await flush();
  assert.equal(ui.widget.hidden, false);
  assert.equal(ui.count.textContent, "12");
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.generatedIds, 0);
  assert.equal(ui.local.values.size, 0);
  assert.equal(ui.calls[0].headers["X-Visitor-ID"], undefined);
  assert.equal(ui.calls[0].url.href, "https://likes.example.test/likes?post=the-questions-we-ask");
  assert.equal(ui.calls[0].credentials, "omit");
  assert.equal(ui.timers.size, 0);
});

test("returning visitors get authoritative liked state and can undo it", async () => {
  const ui = harness({ savedId: visitorId, replies: [response(12, true), response(14, false)] });
  await flush();
  assert.equal(ui.calls[0].headers["X-Visitor-ID"], visitorId);
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  ui.button.click();
  assert.equal(ui.count.textContent, "11");
  await flush();
  assert.equal(ui.calls[1].method, "DELETE");
  assert.deepEqual(JSON.parse(ui.calls[1].body), { postId: "the-questions-we-ask", visitorId });
  assert.equal(ui.count.textContent, "14", "Use the server count, including other readers' changes");
  assert.equal(ui.button.attributes["aria-pressed"], "false");
  assert.equal(ui.status.textContent, "Like removed.");
  assert.equal(ui.generatedIds, 0);
});

test("a first like saves one UUID and ignores overlapping clicks", async () => {
  let resolveWrite;
  const write = new Promise((resolve) => { resolveWrite = resolve; });
  const ui = harness({ replies: [response(3, false), () => write, response(3, false)] });
  await flush();
  ui.button.click();
  ui.button.click();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.attributes["aria-busy"], "true");
  assert.equal(ui.local.values.get(storageKey), visitorId);
  assert.equal(ui.generatedIds, 1);
  resolveWrite(response(4, true));
  await flush();
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  assert.equal(ui.button.disabled, false);
  ui.button.click();
  await flush();
  assert.equal(ui.calls[2].method, "DELETE");
  assert.equal(ui.generatedIds, 1);
});

test("an initial failure shows no fabricated zero and can be retried", async () => {
  const ui = harness({ replies: [new Error("backend details"), response(7, false)] });
  await flush();
  assert.equal(ui.count.hidden, true);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.status.textContent, "Likes are unavailable just now.");
  ui.retry.click();
  await flush();
  assert.equal(ui.count.textContent, "7");
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.retry.hidden, true);
});

test("a stale open tab reuses an identity created by another tab", async () => {
  const ui = harness({ replies: [response(0, false), response(1, true)] });
  await flush();
  ui.local.values.set(storageKey, visitorId);
  ui.button.click();
  await flush();
  assert.equal(ui.generatedIds, 0);
  assert.equal(JSON.parse(ui.calls[1].body).visitorId, visitorId);
});

test("a failed write rolls back and a retry reconciles a write that already succeeded", async () => {
  const ui = harness({ replies: [response(7, false), new Error("Connection lost"), response(8, true)] });
  await flush();
  ui.button.click();
  await flush();
  assert.equal(ui.count.textContent, "7");
  assert.equal(ui.button.attributes["aria-pressed"], "false");
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.retry.hidden, false);
  ui.retry.click();
  await flush();
  assert.equal(ui.calls.length, 3, "Do not repeat a successful write after a lost response");
  assert.equal(ui.calls[2].method, "GET");
  assert.equal(ui.calls[2].headers["X-Visitor-ID"], visitorId);
  assert.equal(ui.count.textContent, "8");
  assert.equal(ui.button.attributes["aria-pressed"], "true");
});

test("a retry repeats an uncommitted change after reconciling server state", async () => {
  const ui = harness({ replies: [response(7, false), { ok: false }, response(9, false), response(10, true)] });
  await flush();
  ui.button.click();
  await flush();
  ui.retry.click();
  await flush();
  assert.deepEqual(ui.calls.map((call) => call.method), ["GET", "POST", "GET", "POST"]);
  assert.equal(ui.count.textContent, "10");
  assert.equal(ui.button.disabled, false);
});

test("an undo failure restores the liked state", async () => {
  const ui = harness({ savedId: visitorId, replies: [response(7, true), { ok: false }] });
  await flush();
  ui.button.click();
  await flush();
  assert.equal(ui.count.textContent, "7");
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  assert.equal(ui.retry.hidden, false);
});

test("blocked local storage uses a session identity and explains its lifetime", async () => {
  const ui = harness({ localBlocked: true, replies: [response(0, false), response(1, true)] });
  await flush();
  ui.button.click();
  await flush();
  assert.equal(ui.session.values.get(storageKey), visitorId);
  assert.match(ui.status.textContent, /remembered for this visit only/);
  assert.equal(ui.button.disabled, false);

  const reload = harness({ localBlocked: true, sessionId: visitorId, replies: [response(1, true)] });
  await flush();
  assert.equal(reload.calls[0].headers["X-Visitor-ID"], visitorId);
  assert.equal(reload.generatedIds, 0);
});

test("blocking all storage still permits like and undo with the same in-memory UUID", async () => {
  const ui = harness({ localBlocked: true, sessionBlocked: true, replies: [response(0, false), response(1, true), response(0, false)] });
  await flush();
  ui.button.click();
  await flush();
  ui.button.click();
  await flush();
  assert.equal(JSON.parse(ui.calls[1].body).visitorId, JSON.parse(ui.calls[2].body).visitorId);
  assert.equal(ui.generatedIds, 1);
  assert.equal(ui.count.textContent, "0");
});

test("invalid counts fail gracefully instead of rendering backend data", async () => {
  for (const count of [-1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1]) {
    const ui = harness({ replies: [response(count, false)] });
    await flush();
    assert.equal(ui.count.hidden, true);
    assert.equal(ui.retry.hidden, false);
  }
});

test("a hung request is aborted and leaves a usable retry", async () => {
  const ui = harness({ replies: [(options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("Aborted")));
  })] });
  for (const callback of ui.timers.values()) callback();
  await flush();
  assert.equal(ui.calls[0].signal.aborted, true);
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.retry.disabled, false);
  assert.equal(ui.timers.size, 0);
});
