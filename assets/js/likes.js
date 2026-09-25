(() => {
  "use strict";

  const widgets = Array.from(document.querySelectorAll("[data-post-likes]"));
  const widget = widgets[0];
  if (!widget) return;

  const controls = widgets.map((widget) => ({
    button: widget.querySelector(".post-likes__button"),
    count: widget.querySelector("[data-like-count]"),
    status: widget.querySelector(".post-likes__status"),
    retry: widget.querySelector(".post-likes__retry"),
  }));
  let activeControl = controls[0];
  const storageKey = "wiigg.likes.visitorId";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let visitorId;
  let temporaryIdentity = false;
  let state;
  let busy = false;
  let retryAction;
  let statusTimer;
  const compactCount = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });

  try {
    const saved = localStorage.getItem(storageKey);
    if (uuid.test(saved)) visitorId = saved;
  } catch {
    temporaryIdentity = true;
  }

  if (!visitorId) {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (uuid.test(saved)) {
        visitorId = saved;
        temporaryIdentity = true;
      }
    } catch {
      // An in-memory identity still allows a like and undo during this visit.
    }
  }

  let endpoint;
  try {
    endpoint = new URL(`${widget.dataset.endpoint.replace(/\/+$/, "")}/likes`);
  } catch {
    return;
  }

  function ensureVisitorId() {
    if (visitorId) return;
    try {
      // Another tab may have created the browser identity since this page loaded.
      const saved = localStorage.getItem(storageKey);
      if (uuid.test(saved)) {
        visitorId = saved;
        temporaryIdentity = false;
        return;
      }
    } catch {
      temporaryIdentity = true;
    }
    visitorId = crypto.randomUUID();
    try {
      localStorage.setItem(storageKey, visitorId);
      temporaryIdentity = false;
    } catch {
      temporaryIdentity = true;
      try {
        sessionStorage.setItem(storageKey, visitorId);
      } catch {
        // Storage is optional; never substitute a fingerprint for this UUID.
      }
    }
  }

  async function request(method = "GET") {
    const url = new URL(endpoint);
    const headers = { Accept: "application/json" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const options = {
      method,
      headers,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    };

    if (method === "GET") {
      url.searchParams.set("post", widget.dataset.postId);
      if (visitorId) headers["X-Visitor-ID"] = visitorId;
    } else {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({ postId: widget.dataset.postId, visitorId });
    }

    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error("Likes request failed");
      const result = await response.json();
      if (!Number.isSafeInteger(result.count) || result.count < 0 || typeof result.liked !== "boolean") {
        throw new Error("Invalid likes response");
      }
      return { count: result.count, liked: result.liked };
    } finally {
      clearTimeout(timeout);
    }
  }

  function render() {
    const liked = state?.liked ?? false;
    const total = state ? `, ${state.count} ${state.count === 1 ? "like" : "likes"}` : "";
    for (const { button, count, retry } of controls) {
      button.setAttribute("aria-pressed", String(liked));
      button.setAttribute("aria-busy", String(busy));
      button.setAttribute("title", liked ? "Unlike" : "Like this article");
      button.disabled = busy || !state || Boolean(retryAction);
      count.hidden = !state || state.count === 0;
      if (state) count.textContent = state.count > 9999 ? compactCount.format(state.count) : state.count.toLocaleString("en-GB");
      button.setAttribute("aria-label", `Like this article${total}`);
      retry.hidden = !retryAction;
      retry.disabled = busy;
    }
  }

  function showStatus(message, kind = "notice") {
    clearTimeout(statusTimer);
    for (const { status } of controls) {
      status.setAttribute("aria-live", status === activeControl.status ? "polite" : "off");
      status.setAttribute("data-status", kind);
      status.setAttribute("data-fading", "false");
      status.textContent = message;
    }
    if (kind === "confirmation") {
      statusTimer = setTimeout(() => {
        for (const { status } of controls) status.setAttribute("data-fading", "true");
        statusTimer = setTimeout(() => {
          showStatus(temporaryIdentity ? "Your choice is remembered for this visit only." : "");
        }, 200);
      }, 2000);
    }
  }

  function announceChange() {
    let message = state.liked ? "Thanks for the like." : "Like removed.";
    if (temporaryIdentity) message += " Your choice is remembered for this visit only.";
    showStatus(message, "confirmation");
  }

  async function load() {
    if (busy) return;
    busy = true;
    retryAction = undefined;
    showStatus("Loading likes…", "loading");
    render();
    try {
      state = await request();
      showStatus("");
    } catch {
      showStatus("Likes are unavailable just now.");
      retryAction = load;
    } finally {
      busy = false;
      render();
    }
  }

  async function setLiked(liked, reconcile = false) {
    if (busy || !state) return;
    busy = true;
    retryAction = undefined;
    showStatus("");
    const previous = state;
    render();

    try {
      ensureVisitorId();
      // A timed-out write may have succeeded. Read first before retrying it.
      if (reconcile) state = await request();
      if (state.liked !== liked) {
        state = { liked, count: Math.max(0, state.count + (liked ? 1 : -1)) };
        render();
        state = await request(liked ? "POST" : "DELETE");
      }
      announceChange();
    } catch {
      state = previous;
      showStatus("Couldn't save that change. Please retry.");
      retryAction = () => setLiked(liked, true);
    } finally {
      busy = false;
      render();
    }
  }

  for (const control of controls) {
    control.button.addEventListener("click", () => {
      if (state && !retryAction && !busy) {
        activeControl = control;
        void setLiked(!state.liked);
      }
    });
    control.retry.addEventListener("click", () => {
      if (retryAction && !busy) {
        activeControl = control;
        void retryAction();
      }
    });
  }
  for (const widget of widgets) widget.hidden = false;
  void load();
})();
