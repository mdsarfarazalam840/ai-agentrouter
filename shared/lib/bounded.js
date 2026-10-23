export function limit(value, fallback, maximum = fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : fallback;
}

export async function boundedFetchText(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = limit(options.timeoutMs, 5000, 10000);
  const maxBytes = limit(options.maxBytes, 262144, 524288);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer;
  let reader;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { abort(); reject(new Error("UPSTREAM_TIMEOUT")); }, timeoutMs);
  });
  const work = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) { const error = new Error("UPSTREAM_HTTP_ERROR"); error.status = response.status; throw error; }
    if (!response.body) return "";
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      const available = maxBytes - size;
      chunks.push(Buffer.from(value.subarray(0, available)));
      size += Math.min(value.byteLength, available);
      if (value.byteLength > available || size >= maxBytes) {
        void reader.cancel().catch(() => {});
        if (!options.truncate) throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
        return Buffer.concat(chunks).toString("utf8") + "\n[diff truncated]";
      }
    }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer); abort(); options.signal?.removeEventListener("abort", abort); if (reader) void reader.cancel().catch(() => {}); }
}

export async function mapLimited(items, concurrency, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await fn(items[index], index); }
  }));
  return output;
}
