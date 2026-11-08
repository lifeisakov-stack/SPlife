// Vercel serverless-функция: ИИ для SPLife внутри Telegram. Работает с разными провайдерами.
// Обязательно: BOT_TOKEN, ALLOWED_IDS (Telegram ID через запятую) и ключ ХОТЯ БЫ ОДНОГО провайдера:
//   ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY | OPENROUTER_API_KEY | AI_API_KEY (+AI_BASE_URL)
// Необязательно: AI_PROVIDER (anthropic|openai|gemini|openrouter|custom), MODEL_QUICK, MODEL_DEFAULT
const crypto = require("crypto");

const PROVIDERS = {
  anthropic: { key: "ANTHROPIC_API_KEY", quick: "claude-haiku-5-5", main: "claude-sonnet-5-5" },
  openai: { key: "OPENAI_API_KEY", base: "https://api.openai.com/v1", quick: "gpt-4o-mini", main: "gpt-4o" },
  gemini: { key: "GEMINI_API_KEY", quick: "gemini-2.0-flash", main: "gemini-2.0-flash" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", quick: "openai/gpt-4o-mini", main: "anthropic/claude-sonnet-4.5" },
  custom: { key: "AI_API_KEY", quick: "", main: "" }, // любой OpenAI-совместимый: DeepSeek, Groq, Mistral... нужен AI_BASE_URL и MODEL_*
};

function pickProvider(env) {
  const want = (env.AI_PROVIDER || "").toLowerCase();
  const name = PROVIDERS[want] ? want : Object.keys(PROVIDERS).find(n => env[PROVIDERS[n].key]);
  return name && env[PROVIDERS[name].key] ? name : null;
}

function checkInitData(initData, botToken) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(str).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch (e) { return null; }
}

async function call(name, env, model, messages, img) {
  const key = env[PROVIDERS[name].key];
  const img64 = img && img.data ? img : null;
  if (name === "anthropic") {
    const ms = messages.map(m => ({ ...m }));
    if (img64) ms[ms.length - 1].content = [{ type: "image", source: { type: "base64", media_type: img64.type, data: img64.data } }, { type: "text", text: ms[ms.length - 1].content }];
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1500, messages: ms }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error && d.error.message);
    return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }
  if (name === "gemini") {
    const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    if (img64) contents[contents.length - 1].parts.unshift({ inline_data: { mime_type: img64.type, data: img64.data } });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ contents }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error && d.error.message);
    return (((d.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || "").join("");
  }
  // OpenAI и совместимые (openai, openrouter, custom)
  const base = (name === "custom" ? env.AI_BASE_URL : PROVIDERS[name].base || "").replace(/\/$/, "");
  if (!base) throw new Error("AI_BASE_URL не задан");
  const ms = messages.map(m => ({ ...m }));
  if (img64) ms[ms.length - 1].content = [{ type: "text", text: ms[ms.length - 1].content }, { type: "image_url", image_url: { url: `data:${img64.type};base64,${img64.data}` } }];
  const r = await fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ model, messages: ms, max_tokens: 1500 }) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error && (d.error.message || d.error));
  return (((d.choices || [])[0] || {}).message || {}).content || "";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env, name = pickProvider(env);
  if (req.method === "GET") return res.status(200).json({ ok: !!(env.BOT_TOKEN && name), provider: name, bot: !!env.BOT_TOKEN, key: !!name, allowed: !!(env.ALLOWED_IDS || "").trim() });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!env.BOT_TOKEN || !name) return res.status(500).json({ error: "not_configured" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const user = checkInitData(body.initData, env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const allowed = (env.ALLOWED_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!allowed.includes(String(user.id))) return res.status(403).json({ error: "forbidden", userId: user.id });

  const messages = (body.messages || []).slice(-20).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 12000) }));
  if (!messages.length) return res.status(400).json({ error: "empty" });
  const quick = body.tier === "quick", P = PROVIDERS[name];
  const model = (quick ? env.MODEL_QUICK : env.MODEL_DEFAULT) || (quick ? P.quick : P.main);
  if (!model) return res.status(500).json({ error: "not_configured", detail: "Задай MODEL_QUICK и MODEL_DEFAULT" });
  try {
    const text = await call(name, env, model, messages, body.image ? { data: body.image, type: body.mediaType || "image/jpeg" } : null);
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "upstream", detail: String(e.message || e).slice(0, 300) });
  }
};
