const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers }
});

function cors(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) return null;
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

async function checkTurnstile(token, request, env) {
  if (!token || token.length > 4096) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && result.hostname === env.ALLOWED_HOSTNAME && result.action === "try_on";
}

async function enforceHourlyLimit(request, env) {
  if (!env.TRYON_LIMITS) throw new Error("Try-on rate-limit storage is not configured.");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const key = "ip:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const count = Number(await env.TRYON_LIMITS.get(key) || 0);
  const limit = Math.max(1, Math.min(12, Number(env.MAX_TRYON_REQUESTS_PER_HOUR) || 8));
  if (count >= limit) return false;
  await env.TRYON_LIMITS.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

function safeProductImage(value, env) {
  try {
    const url = new URL(value);
    const hosts = (env.ALLOWED_PRODUCT_IMAGE_HOSTS || "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    return url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function safeModelImage(value, env) {
  if (!value) return true;
  if (value === env.MODEL_IMAGE_URL) return true;
  return typeof value === "string" && value.length <= 12_000_000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
}

async function fashnRequest(path, init, env) {
  return fetch("https://api.fashn.ai" + path, {
    ...init,
    headers: { authorization: "Bearer " + env.FASHN_API_KEY, ...(init?.headers || {}) }
  });
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (!headers) return new Response("Origin not allowed", { status: 403 });
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ready: Boolean(env.FASHN_API_KEY && env.TURNSTILE_SECRET && env.TRYON_LIMITS && env.MODEL_IMAGE_URL) }, 200, headers);
    }
    if (!env.FASHN_API_KEY || !env.TURNSTILE_SECRET || !env.MODEL_IMAGE_URL) return json({ error: "The try-on service is not configured yet." }, 503, headers);

    if (request.method === "POST" && url.pathname === "/api/try-on") {
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 15_000_000) return json({ error: "The preview request is too large." }, 413, headers);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Send a valid JSON request." }, 400, headers); }
      if (!safeProductImage(body.productImage, env)) return json({ error: "This product image host is not enabled for try-on." }, 400, headers);
      if (!safeModelImage(body.modelImage, env)) return json({ error: "The preview image is not valid." }, 400, headers);
      if (!await checkTurnstile(body.turnstileToken, request, env)) return json({ error: "Please complete the anti-abuse check and try again." }, 403, headers);
      try {
        if (!await enforceHourlyLimit(request, env)) return json({ error: "Preview limit reached for now. Please try again later." }, 429, headers);
        const upstream = await fashnRequest("/v1/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model_name: "tryon-max",
            inputs: {
              model_image: body.modelImage || env.MODEL_IMAGE_URL,
              product_image: body.productImage,
              resolution: "1k",
              generation_mode: "fast",
              output_format: "jpeg",
              return_base64: true
            }
          })
        }, env);
        const result = await upstream.json();
        if (!upstream.ok || !result.id) return json({ error: result.message || result.error?.message || result.error || "The try-on provider could not start this preview." }, 502, headers);
        return json({ id: result.id }, 202, headers);
      } catch (error) {
        return json({ error: error.message || "The try-on service is temporarily unavailable." }, 503, headers);
      }
    }

    const match = request.method === "GET" && url.pathname.match(/^\/api\/try-on\/([A-Za-z0-9-]{10,100})$/);
    if (match) {
      try {
        const upstream = await fashnRequest("/v1/status/" + encodeURIComponent(match[1]), {}, env);
        const result = await upstream.json();
        if (!upstream.ok) return json({ error: "Could not check the preview yet." }, 502, headers);
        if (result.status === "failed") return json({ status: "failed", error: result.error?.message || "The provider could not create this preview." }, 200, headers);
        const output = Array.isArray(result.output) ? result.output[0] : null;
        if (result.status === "completed" && typeof output === "string" && output.startsWith("data:image/")) {
          return json({ status: "completed", output }, 200, headers);
        }
        return json({ status: result.status || "processing" }, 200, headers);
      } catch {
        return json({ error: "Could not check the preview yet." }, 503, headers);
      }
    }

    return json({ error: "Not found." }, 404, headers);
  }
};
