(() => {
  "use strict";

  const counts = document.querySelectorAll("[data-post-like-count]");
  const requests = new Map();
  const compact = new Intl.NumberFormat("en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
    useGrouping: false,
  });

  async function readCount(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Like count unavailable");
      const result = await response.json();
      if (!result || !Number.isSafeInteger(result.count) || result.count < 0) {
        throw new Error("Invalid like count");
      }
      return result.count;
    } finally {
      clearTimeout(timeout);
    }
  }

  for (const element of counts) {
    const number = element.querySelector("[data-count-number]");
    const label = element.querySelector("[data-count-label]");
    let url;
    try {
      url = new URL(`${element.dataset.endpoint.replace(/\/+$/, "")}/likes`);
      url.searchParams.set("post", element.dataset.postId);
    } catch {
      continue;
    }

    label.textContent = "Loading like count.";
    element.setAttribute("title", "Loading like count");
    if (!requests.has(url.href)) requests.set(url.href, readCount(url));
    requests.get(url.href).then((count) => {
      const exact = count.toLocaleString("en-GB");
      const description = `${exact} ${count === 1 ? "like" : "likes"}`;
      number.textContent = count > 9999 ? compact.format(count) : exact;
      label.textContent = description;
      element.setAttribute("title", description);
    }).catch(() => {
      label.textContent = "Like count unavailable.";
      element.setAttribute("title", "Like count unavailable");
    });
  }
})();
