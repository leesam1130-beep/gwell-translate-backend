// GWELL Translate Backend
// 给 Chrome 扩展 (gwell-wa-crm-extension) 提供 OpenAI 代理服务，
// OpenAI Key 仅保存在服务端环境变量，插件端不再持有任何密钥。
//
// Endpoints:
//   GET  /                              healthcheck (legacy)
//   GET  /api/health                    extension uses this for "测试连接"
//   POST /api/translate                 中文 → 客户语言（含语种识别 + JSON schema）
//   POST /api/batch-translate-incoming  批量来信 → 中文（含 12 类意图 + 自动升级）
//   POST /translate                     legacy 简单翻译（保持向后兼容）

import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

if (!OPENAI_API_KEY) {
  console.warn("[gwell-backend] WARNING: OPENAI_API_KEY is not set; all translation routes will fail.");
}

// ============================================================
// 用户名白名单(可选)
// ============================================================
// GWELL_ALLOWED_USERS:
//   - 未设置 / 空字符串 → 完全放行（phase-1：无需登录，任何请求都允许）
//   - 设置为 "alice,bob,charlie" → 只允许 X-GWELL-User 头里这些用户名（phase-2：开始按用户名校验）
// 切换 phase 完全是后端单边操作：在 Railway 控制台改环境变量 → Redeploy。
// 插件端不需要任何改动，已经在每次请求都带上 X-GWELL-User 头。
const RAW_ALLOWED_USERS = String(process.env.GWELL_ALLOWED_USERS || "").trim();
const ALLOWED_USERS = RAW_ALLOWED_USERS
  ? new Set(RAW_ALLOWED_USERS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const AUTH_ENABLED = !!ALLOWED_USERS && ALLOWED_USERS.size > 0;

if (AUTH_ENABLED) {
  console.log(`[gwell-backend] auth ENABLED, ${ALLOWED_USERS.size} allowed user(s): ${Array.from(ALLOWED_USERS).join(", ")}`);
} else {
  console.log("[gwell-backend] auth DISABLED (GWELL_ALLOWED_USERS unset/empty) — all requests allowed.");
}

// ============================================================
// Token 节流参数（服务端硬限制，与插件端无关）
// ============================================================
// 即使插件发来 50 条客户消息 / 每条 5000 字，后端也只取最近 N 条 + 截断每条到 M 字符。
// 这是"防御性裁剪"：保证 input token 上限可控，不依赖插件版本。
//   MAX_CUSTOMER_MSGS    /api/translate 客户消息保留最近多少条（默认 5）
//   MAX_CUSTOMER_MSG_LEN 单条客户消息最大字符数（默认 400）
//   MAX_BATCH_CONTEXT    /api/batch-translate-incoming recentContext 保留多少条（默认 5）
//   MAX_BATCH_CTX_LEN    单条 recentContext 最大字符数（默认 200）
//   MAX_BATCH_ITEM_LEN   batch item.text 最大字符数（默认 800）
function envInt(name, defVal, min, max) {
  const v = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(v)) return defVal;
  return Math.max(min, Math.min(max, v));
}
const MAX_CUSTOMER_MSGS    = envInt("MAX_CUSTOMER_MSGS", 5, 0, 50);
const MAX_CUSTOMER_MSG_LEN = envInt("MAX_CUSTOMER_MSG_LEN", 400, 50, 4000);
const MAX_BATCH_CONTEXT    = envInt("MAX_BATCH_CONTEXT", 5, 0, 30);
const MAX_BATCH_CTX_LEN    = envInt("MAX_BATCH_CTX_LEN", 200, 50, 2000);
const MAX_BATCH_ITEM_LEN   = envInt("MAX_BATCH_ITEM_LEN", 800, 50, 4000);

console.log(
  `[gwell-backend] token caps: customerMsgs=${MAX_CUSTOMER_MSGS}x${MAX_CUSTOMER_MSG_LEN}ch, ` +
  `batchCtx=${MAX_BATCH_CONTEXT}x${MAX_BATCH_CTX_LEN}ch, batchItem=${MAX_BATCH_ITEM_LEN}ch`
);

// 把"过长字符串"安全截断，并在末尾留一个标记，让模型知道是被截断的
function truncStr(s, maxLen) {
  const str = String(s == null ? "" : s);
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 3)) + "...";
}

function getReqUser(req) {
  return String(req.get("x-gwell-user") || "").trim();
}

function requireUser(req, res, next) {
  const user = getReqUser(req);
  req._user = user || null;

  if (!AUTH_ENABLED) {
    // phase-1：白名单未启用，全部放行；只是把用户名记进 log 方便后续追踪
    if (user) console.log(`[gwell-backend] [${req.method} ${req.path}] user=${user} (auth disabled)`);
    return next();
  }

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "USERNAME_REQUIRED",
      hint: "请在 GWELL CRM 设置中填写已开通的用户名后重试"
    });
  }
  if (!ALLOWED_USERS.has(user)) {
    return res.status(401).json({
      ok: false,
      error: "USERNAME_NOT_ALLOWED",
      hint: `用户名「${user}」未授权，请联系管理员开通`
    });
  }

  console.log(`[gwell-backend] [${req.method} ${req.path}] user=${user} (ok)`);
  next();
}

// ============================================================
// OpenAI Responses API caller (1:1 与旧 background.js 行为一致)
// ============================================================
// Token 优化关键点：
// 1. instructions 必须是【静态常量】才能命中 OpenAI automatic prompt caching
//    （≥1024 tokens 的稳定前缀，缓存命中时 input token 半价）
// 2. 所有 per-request 的动态内容（客户名、override 语言等）必须放进 input，
//    不能拼进 instructions，否则 prefix 每次都变 → 永远 cache miss。
// 3. prompt_cache_key：跨 Railway 多实例 / OpenAI 多副本时，把同一个用例的
//    请求稳定路由到同一份缓存，进一步提高命中率。
async function callOpenAIResponses({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000,
  promptCacheKey = null,
  logTag = ""
}) {
  if (!OPENAI_API_KEY) throw new Error("Server missing OPENAI_API_KEY");
  if (!model) throw new Error("Missing model");

  const body = { model, instructions, input, temperature };
  if (jsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: jsonSchema.name || "result",
        schema: jsonSchema.schema,
        strict: jsonSchema.strict !== false
      }
    };
  }
  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`OpenAI timeout (${timeoutMs}ms)`);
    throw new Error("OpenAI network error: " + (err?.message || String(err)));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let raw = "";
    try { raw = await res.text(); } catch {}
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const msg = parsed?.error?.message || raw.slice(0, 300) || res.statusText;
    const e = new Error(`OpenAI ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  let text = data.output_text || "";
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && typeof c.text === "string") text += c.text;
        }
      }
    }
  }

  // 把 token 用量打到 Railway 日志，方便你随时观察缓存命中率
  // cached_tokens 越接近 input_tokens，说明缓存越生效；
  // 第一次调用通常 cached=0，后续相同 prefix 请求会快速涨到接近 100%。
  const usage = data.usage || null;
  if (usage) {
    const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const cachePct = inTok > 0 ? Math.round((cached / inTok) * 100) : 0;
    const ratio = outTok > 0 ? (inTok / outTok).toFixed(1) : "n/a";
    console.log(
      `[openai${logTag ? " " + logTag : ""}] model=${model} in=${inTok} cached=${cached}(${cachePct}%) out=${outTok} ratio=${ratio}x${promptCacheKey ? " key=" + promptCacheKey : ""}`
    );
  }

  return { text: String(text || "").trim(), usage, raw: data };
}

// ============================================================
// 翻译 prompt / schema —— 全部从插件 background.js 搬过来
// ============================================================

// === 12 类销售意图 ===
const INTENT_ENUM = [
  "ask_location",
  "ask_price",
  "ask_stock",
  "ask_product_info",
  "ask_catalog_media",
  "ask_delivery",
  "ask_payment",
  "ask_visit_or_business",
  "after_sales_complaint",
  "customer_interested",
  "customer_not_interested",
  "other"
];

const BATCH_TRANSLATE_SCHEMA = {
  name: "batch_translate_to_zh",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            translation_cn: { type: "string" },
            intent: { type: "string", enum: INTENT_ENUM },
            secondary_intents: {
              type: "array",
              items: { type: "string", enum: INTENT_ENUM }
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          },
          required: ["id", "translation_cn", "intent", "secondary_intents", "confidence"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};

const BATCH_TRANSLATE_INSTRUCTIONS = `You are a WhatsApp translator + intent classifier for GWELL, a Chinese lighting factory with office at Kariakoo (Dar es Salaam) and factory at Kigamboni. Customers are East-African buyers writing Swahili / English / Mixed, with typos, abbreviations and short messages.

== INPUT FORMAT ==
Input MAY start with an "== CONVERSATION CONTEXT ==" block: customer's recent prior messages, oldest → newest. REFERENCE ONLY — do NOT translate them, do NOT include in output. Use them to resolve abbreviations & pointing words in the actual items.

== TASKS PER ITEM ==
1. translation_cn — Simplified Chinese translation.
   - Already Chinese / pure URL / pure emoji → "" (empty).
   - Short cryptic message ("Vp", "Hii", "Ngp", "30W", "Bei") → MUST resolve via CONTEXT and produce a COMPLETE Chinese sentence including the topic. NEVER output 2-char literals like "价" / "怎样" / "多少".
   - If context is empty AND the item is genuinely a poke ("Vp"), translate to "怎么样？/在吗？" with confidence=low.
2. intent (primary) + secondary_intents (others that also match, or []) + confidence.

== CONTEXT-RESOLVED EXAMPLES (study these patterns) ==
ctx=["Mna A60 LED bulb?"]  item="Ngp"  → translation_cn="A60 LED 球泡多少钱？" intent=ask_price
ctx=["Mna taa za solar?"]  item="Bei"  → translation_cn="太阳能灯多少钱？"     intent=ask_price
ctx=["nahii","30W"]        item="Vp"   → translation_cn="30W 这款怎么样？有货吗？" intent=ask_stock
ctx=[]                     item="Vp"   → translation_cn="怎么样？/在吗？"      intent=other confidence=low

== 12 INTENTS (you know Swahili; pick the closest) ==
ask_location: address/street/where (wapi, mtaa, Kariakoo, Kigamboni)
ask_price: price/wholesale/retail/bargain/quantity/carton-pack/promotion (bei, ngapi, jumla, punguza, qty)
ask_stock: in stock? (mna, ipo, available)
ask_product_info: model/spec/category/feature/battery/warranty (watts, taa, tochi, sola, sensor, battery, warranty)
ask_catalog_media: photos/videos/catalog/price-list (picha, video, list)
ask_delivery: shipping incl. cross-border (mnatuma, mikoani, cargo, Congo/DRC/Zambia)
ask_payment: payment methods (Mpesa, TigoPesa, NMB, bank, cash)
ask_visit_or_business: visit/inspect/business-hours/invoice/dealer (kuja, sample, open, invoice, dealer)
after_sales_complaint: broken/not working/return (imeharibika, haifanyi, return)
customer_interested: yes/ok/want it (sawa, ndio, nataka, nachukua)
customer_not_interested: no/too expensive/later (hapana, ghali, baadaye)
other: greetings, Asante, emoji-only, unresolvable abbreviations.

== PRIORITY (pick PRIMARY in this order when multiple match) ==
after_sales_complaint > ask_location > ask_price > ask_stock > ask_delivery > ask_payment > ask_product_info > ask_catalog_media > ask_visit_or_business > customer_interested/not_interested > other.
secondary_intents[]: other matched intents (max 3), empty [] if only one.
Ambiguous short ("Vp", "Hii", "Ngp", bare wattages): if context resolves → use resolved intent; else "other" + confidence=low.

confidence: high (clear) | medium (typos or 2 plausible intents) | low (too short / garbled / no context).

== GWELL CONTEXT (model doesn't know) ==
Kariakoo=达市批发区, Kigamboni=GWELL 工厂区, ngp=ngapi, vp=vipi, nahii=na hii=这个呢

== GOLDEN EXAMPLES ==

1) item="Kariakoo mpo mtaa gani"
{"translation_cn":"你们在 Kariakoo 哪条街？","intent":"ask_location","secondary_intents":[],"confidence":"high"}

2) item="Mna tochi Kariakoo wapi?"   (multi-intent)
{"translation_cn":"你们的手电筒在 Kariakoo 哪里？","intent":"ask_location","secondary_intents":["ask_product_info","ask_stock"],"confidence":"high"}

Respond strictly with the provided JSON schema.`;

// === 中→客户语言 schema ===
const TRANSLATE_SCHEMA = {
  name: "translation_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      detectedLanguage: { type: "string" },
      detectedLanguageConfidence: { type: "string", enum: ["high", "medium", "low"] },
      detectionReason: { type: "string" },
      translation: { type: "string" }
    },
    required: ["detectedLanguage", "detectedLanguageConfidence", "detectionReason", "translation"],
    additionalProperties: false
  }
};

// ⚠️ 必须保持完全静态(不允许任何模板插值)，否则会破坏 OpenAI prompt cache。
// 客户名/手机/override 语言等动态内容请放到 buildOutboundInput 里。
const OUTBOUND_INSTRUCTIONS = `You are an expert translator working for GWELL, a Chinese lighting factory exporting to Tanzania and East Africa via WhatsApp Business.

You will receive a structured user message that contains some of these blocks (in this order):
  - "## Target language override" (optional) — if present, FORCE the target language to it; set detectedLanguage to that value with confidence "high" and detectionReason "manual override".
  - "## Customer profile" (optional) — saved name / phone / phone country hint / status line. Use ONLY for tone calibration; never mention these in the translation output.
  - "## Customer recent messages (oldest → newest)" — used to detect the customer's language.
  - "## Salesperson Chinese reply (translate this)" — the actual text to translate.

Tasks:
1. If "## Target language override" is present, use it as detectedLanguage. Otherwise detect the customer's primary language from their recent messages. If they only sent emojis / very short text / no messages, use the phone country hint (if provided), otherwise fall back to English. Pick the dominant language if mixed.
2. Translate the Chinese reply into that language.

== BUSINESS PROFILE ==
GWELL = Chinese-owned lighting company with REAL LOCAL PRESENCE in Tanzania.
- China HQ: Chinese lighting manufacturer
- Tanzania Office: Kariakoo, Dar es Salaam
- Tanzania Factory: Kigamboni, Dar es Salaam
When translating Chinese replies that mention our location, always use the above addresses confidently (do NOT say "我们只在中国" / "we only ship from China" — we are physically in DAR).

Product lines: LED bulbs (A60/A70/A100, E27/B22 base), LED tube lights (T5/T8, 0.6m/0.9m/1.2m), torches/flashlights, emergency lights, solar products (home systems 1-to-3 / 1-to-5, street lights, flood lights, lanterns), rechargeable fans, mosquito killer lamps (UV), flood/street/garden/security lights, panel/downlights, ceiling/work lights, headlamps.

Typical customer: Tanzania-based distributor / wholesaler / retail shop / project contractor. They ask about prices, MOQ, lead time, payment terms, samples, packaging, certificates, container loading.

== LOCATION TERMINOLOGY (Chinese → Swahili, use these EXACT mappings) ==
- 我们在达累斯萨拉姆 / 我们在 DAR → Tupo Dar es Salaam
- 办公室在 Kariakoo → Tuna ofisi Kariakoo / Ofisi yetu ipo Kariakoo
- 工厂在 Kigamboni → Tuna factory Kigamboni / Kiwanda chetu kipo Kigamboni
- 我发位置给你 → Nitakutumia location sasa hivi
- 欢迎过来 → Karibu sana
- 今天可以来吗 → Unataka kuja leo?
- 哪条街 → mtaa gani; 哪栋楼 → jengo gani; 靠近 X → karibu na X

== CHINESE → SWAHILI/ENGLISH TERMINOLOGY (use these mappings; rest you already know) ==
Products: 灯/灯具→taa; 灯泡→balbu; 球泡→balbu; 灯管→tube light; 手电筒→tochi; 应急灯→emergency light; 太阳能灯→taa ya sola; 太阳能板→solar panel; 太阳能一拖三/一拖五→solar system 1-to-3 / 1-to-5 (keep English, customers know it); 充电灯→rechargeable light; 充电小风扇→rechargeable fan; 灭蚊灯→mosquito killer; 投光灯/泛光灯→flood light; 路灯→street light; 工矿灯→high-bay light; 头灯→headlamp; 筒灯/射灯→downlight/spotlight; 吸顶灯→ceiling light.

Technical specs — KEEP IN ENGLISH/NUMBERS: 瓦数→W (9W/30W); 电压→V; 流明→lm; 色温→3000K (warm) / 6500K (cool); 显色指数→CRI; 防水→IP65/IP67; 灯头→E27/B22/E14; 充电时间→charging time; 续航→backup time; 电池容量→mAh; 太阳能板瓦数→Wp.

Commercial: 价格→bei/price; 批发价→bei ya jumla; 零售价→bei ya rejareja; 起订量→MOQ; 整箱→katoni/carton; 内盒→inner box; 外箱→master carton; 包装→packing; 彩盒→color box; 中性包装→neutral packing; OEM→OEM; 货期→lead time; 整柜→container/kontena (20'GP/40'GP/40'HQ); 海运→by sea; 空运→by air; 港口→bandari; 样品→sample/sampuli; 样品费→sample charge; 保修→warranty; 认证→CE/RoHS/TUV/EAC; 付款方式→payment terms; 30%订金70%尾款→30% deposit + 70% balance before shipment; TT→T/T; 信用证→L/C; 美金→USD; 坦桑先令→TZS.

Style rules:
- Friendly, natural, business-appropriate for WhatsApp — like a real export salesperson, not stiff.
- For Swahili customers, mixing common English business words (price, order, MOQ, container, USD, sample, warranty) is normal and PREFERRED over forced literal translation.
- Add appropriate greeting/closing if Chinese source has it (您好→Habari/Hello dear; 祝好→Thanks & regards).
- Preserve line breaks, numbers, units (W/V/lm/K/kg/mm/USD/TZS/%), product codes/SKUs, emojis, URLs, @mentions, phone numbers exactly.
- Translate the *meaning* of Chinese idioms, never word-for-word.
- Output the translation only — no quotes, no "Translation:" prefix, no markdown fences.

Respond strictly with the JSON schema provided.`;

function buildOutboundInput({ customerMessages, sourceText, overrideLanguage, contextHint }) {
  const lines = [];

  if (overrideLanguage) {
    lines.push("## Target language override");
    lines.push(String(overrideLanguage));
    lines.push("");
  }

  const cust = contextHint || {};
  const custLines = [];
  if (cust.name) custLines.push(`- Saved name / chat title: ${cust.name}`);
  if (cust.phone) custLines.push(`- Phone: ${cust.phone}`);
  if (cust.phoneLangHint) custLines.push(`- Phone country hint: likely ${cust.phoneLangHint}`);
  if (cust.subtitle) custLines.push(`- Status line: ${cust.subtitle}`);
  if (custLines.length) {
    lines.push("## Customer profile (tone hint only — do NOT mention in translation)");
    lines.push(...custLines);
    lines.push("");
  }

  lines.push("## Customer recent messages (oldest → newest)");
  if (!customerMessages || customerMessages.length === 0) {
    lines.push("(none — no incoming messages were readable from the current chat)");
  } else {
    customerMessages.forEach((m, i) => {
      const t = m.time ? ` [${m.time}]` : "";
      lines.push(`${i + 1}.${t} ${m.text}`);
    });
  }
  lines.push("");
  lines.push("## Salesperson Chinese reply (translate this)");
  lines.push(sourceText);
  return lines.join("\n");
}

// ============================================================
// Routes
// ============================================================

app.get("/", (req, res) => {
  res.send("Translation backend is running.");
});

// /api/health 是"探活"接口，本身永远不会 401。
// 把当前请求带的用户名 & 白名单状态如实返回给前端，
// 前端可以据此显示"未授权 / 已授权 / 白名单未启用"等精确状态。
app.get("/api/health", (req, res) => {
  const user = getReqUser(req);
  let authorized;
  if (!AUTH_ENABLED) authorized = true;             // 白名单关 → 所有人都"已授权"
  else if (!user) authorized = false;                // 白名单开但没传用户名
  else authorized = ALLOWED_USERS.has(user);         // 白名单开 → 看是否命中

  res.json({
    ok: true,
    hasKey: !!OPENAI_API_KEY,
    authEnabled: AUTH_ENABLED,
    allowedCount: AUTH_ENABLED ? ALLOWED_USERS.size : 0,
    yourUser: user || null,
    authorized
  });
});

// === 主路由 1：outbound 中→客户语言 ===
app.post("/api/translate", requireUser, async (req, res) => {
  try {
    const {
      sourceText,
      customerMessages = [],
      overrideLanguage = null,
      contextHint = null,
      model = "gpt-4o-mini"
    } = req.body || {};

    const src = String(sourceText || "").trim();
    if (!src) return res.status(400).json({ ok: false, error: "EMPTY_SOURCE" });

    // 防御性裁剪：只取最近 N 条客户消息 + 每条截断，不管插件发了多少。
    const rawMsgs = Array.isArray(customerMessages) ? customerMessages : [];
    const trimmedMsgs = rawMsgs
      .slice(-MAX_CUSTOMER_MSGS)
      .map((m) => ({
        time: m && m.time ? String(m.time) : "",
        text: truncStr(m && m.text, MAX_CUSTOMER_MSG_LEN)
      }))
      .filter((m) => m.text);
    if (rawMsgs.length > trimmedMsgs.length) {
      console.log(
        `[/api/translate] trimmed customerMessages: ${rawMsgs.length} → ${trimmedMsgs.length} (cap=${MAX_CUSTOMER_MSGS})`
      );
    }

    // 注意：instructions 必须用静态常量；overrideLanguage / contextHint 全部进 input。
    // 这样 OpenAI 的 prompt cache 才能命中（≥1024 token 稳定 prefix → cached input 半价）。
    const input = buildOutboundInput({
      customerMessages: trimmedMsgs,
      sourceText: src,
      overrideLanguage,
      contextHint
    });

    const { text, usage } = await callOpenAIResponses({
      model,
      instructions: OUTBOUND_INSTRUCTIONS,
      input,
      jsonSchema: TRANSLATE_SCHEMA,
      temperature: 0.3,
      promptCacheKey: `gwell-outbound-${model}`,
      logTag: "/api/translate"
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        detectedLanguage: overrideLanguage || "Unknown",
        detectedLanguageConfidence: "low",
        detectionReason: "Model returned non-JSON; treated raw text as translation.",
        translation: text
      };
    }

    res.json({ ok: true, ...parsed, usage, model });
  } catch (err) {
    console.error("[/api/translate]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === 主路由 2：批量来信 → 中文 + 意图 + auto-upgrade ===
app.post("/api/batch-translate-incoming", requireUser, async (req, res) => {
  try {
    const {
      items: rawItems,
      recentContext: rawCtx = [],
      model = "gpt-4o-mini",
      upgradeModel = null
    } = req.body || {};

    const rawItemsArr = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
    if (rawItemsArr.length === 0) return res.json({ ok: true, translations: [] });

    // 防御性裁剪：单条 batch item.text 最长 MAX_BATCH_ITEM_LEN 字符。
    // 不限制 item 数量(由插件端决定批次大小)，只截断单条文本，避免一条超长消息拉爆 token。
    const items = rawItemsArr.map((it) => ({
      ...it,
      text: truncStr(it && it.text, MAX_BATCH_ITEM_LEN)
    }));
    const longCount = rawItemsArr.filter(
      (it) => String((it && it.text) || "").length > MAX_BATCH_ITEM_LEN
    ).length;
    if (longCount > 0) {
      console.log(
        `[/api/batch-translate-incoming] truncated ${longCount} oversize item(s) to ${MAX_BATCH_ITEM_LEN}ch`
      );
    }

    // 防御性裁剪：recentContext 只保留最近 MAX_BATCH_CONTEXT 条 + 每条截断。
    const rawCtxArr = (Array.isArray(rawCtx) ? rawCtx : [])
      .map((s) => String(s || "").replace(/\r?\n/g, " ").trim())
      .filter(Boolean);
    const recentContext = rawCtxArr
      .slice(-MAX_BATCH_CONTEXT)
      .map((s) => truncStr(s, MAX_BATCH_CTX_LEN));
    if (rawCtxArr.length > recentContext.length) {
      console.log(
        `[/api/batch-translate-incoming] trimmed recentContext: ${rawCtxArr.length} → ${recentContext.length} (cap=${MAX_BATCH_CONTEXT})`
      );
    }

    let contextBlock = "";
    if (recentContext.length) {
      const ctxLines = recentContext.map((t, i) => `${i + 1}. ${t}`).join("\n");
      contextBlock =
`== CONVERSATION CONTEXT (recent customer messages, oldest → newest) ==
These are the customer's previous messages, given for REFERENCE ONLY.
Do NOT translate them. Use them only to understand pointing words ("hii", "nahii", "iyo"),
bare wattages / specs ("30W", "E27"), short questions ("Bei?", "Ngapi?"), and ambiguous replies.

${ctxLines}

== END CONTEXT ==

`;
    }

    async function callBatchOnce({ model: m, items: subItems, isUpgrade = false }) {
      const subLines = subItems.map((it, idx) => {
        const safeText = String(it.text || "").replace(/\r?\n/g, "\n");
        return `[item ${idx + 1}] id=${it.id}\n${safeText}`;
      });
      const subInput =
`${contextBlock}Translate the following ${subItems.length} foreign-language customer message(s) into Simplified Chinese.

${subLines.join("\n\n---\n\n")}`;
      const { text, usage } = await callOpenAIResponses({
        model: m,
        instructions: BATCH_TRANSLATE_INSTRUCTIONS,
        input: subInput,
        jsonSchema: BATCH_TRANSLATE_SCHEMA,
        temperature: 0.2,
        timeoutMs: 60000,
        promptCacheKey: `gwell-batch-incoming-${m}`,
        logTag: isUpgrade ? "/api/batch upgrade" : "/api/batch"
      });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error("BAD_JSON_FROM_MODEL: " + (err?.message || String(err)));
      }
      return { items: Array.isArray(parsed?.items) ? parsed.items : [], usage };
    }

    const { items: translations, usage } = await callBatchOnce({ model, items });

    // 自动升级：把 confidence=low 的条目用更强模型重译
    const canUpgrade = upgradeModel && upgradeModel !== model && translations.length > 0;
    let upgradedIds = [];
    let upgradeUsage = null;

    if (canUpgrade) {
      const lowIds = new Set(
        translations.filter((t) => t && t.confidence === "low").map((t) => t.id)
      );
      if (lowIds.size > 0) {
        const retryItems = items.filter((it) => lowIds.has(it.id));
        try {
          console.log(`[batch] auto-upgrade: ${retryItems.length} low-conf items: ${model} → ${upgradeModel}`);
          const retry = await callBatchOnce({ model: upgradeModel, items: retryItems, isUpgrade: true });
          const retryMap = new Map(retry.items.map((t) => [t.id, t]));
          for (let i = 0; i < translations.length; i++) {
            const t = translations[i];
            if (t && retryMap.has(t.id)) {
              const better = retryMap.get(t.id);
              translations[i] = { ...better, upgraded: true, upgradedFrom: model };
              upgradedIds.push(t.id);
            }
          }
          upgradeUsage = retry.usage;
        } catch (err) {
          console.warn("[batch] auto-upgrade failed (keep base result):", err?.message || err);
        }
      }
    }

    res.json({
      ok: true,
      translations,
      usage,
      upgradeUsage,
      upgradedIds,
      model,
      upgradeModel: canUpgrade ? upgradeModel : null
    });
  } catch (err) {
    console.error("[/api/batch-translate-incoming]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === Legacy 简单翻译，保留向后兼容 ===
app.post("/translate", requireUser, async (req, res) => {
  try {
    const { text, targetLanguage } = req.body || {};
    if (!text) return res.status(400).json({ error: "Missing text" });

    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });

    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `你是一个专门用于 WhatsApp 外贸聊天的翻译助手。
业务背景：用户是在坦桑尼亚达累斯萨拉姆的灯具工厂。
主要产品：LED bulb, torch, emergency light, solar light, mosquito killer, fan, kettle。
主要客户语言：斯瓦希里语、英语、法语、刚果法语。
翻译规则：
1. 如果输入是中文，就翻译成目标语言。
2. 如果输入不是中文，就翻译成中文。
3. 不要逐字死翻，要结合 WhatsApp 销售场景理解。
4. 输出只给翻译结果，不要解释。`
          },
          {
            role: "user",
            content: `目标语言：${targetLanguage || "中文"}\n需要翻译的内容：\n${text}`
          }
        ]
      })
    });

    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `OpenAI ${r.status}: ${bodyText.slice(0, 300)}` });
    }
    const data = await r.json();
    res.json({ translation: data?.choices?.[0]?.message?.content || "" });
  } catch (error) {
    console.error("[/translate]", error);
    res.status(500).json({ error: "Translation failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
