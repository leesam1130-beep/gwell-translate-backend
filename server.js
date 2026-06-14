// GWELL Translate Backend
// 给 Chrome 扩展 (gwell-wa-crm-extension) 提供 OpenAI 代理服务，
// OpenAI Key 仅保存在服务端环境变量，插件端不再持有任何密钥。
//
// Endpoints:
//   GET  /                              healthcheck (legacy)
//   GET  /api/health                    extension uses this for "测试连接"
//   POST /api/translate                 中文 → 客户语言（slim prompt 默认；mode:"expert" 可回退）
//   POST /api/batch-translate-incoming  批量来信 → 中文（slim prompt 默认；含 12 类意图 + 自动升级）
//   POST /intent                        意图识别（本地关键词优先，AI fallback；不带产品/历史）
//   POST /quote                         产品报价（仅匹配到的 1-5 条产品，不传整库）
//   POST /translate                     legacy 简单翻译（保持向后兼容）
//
// Token 优化（2026-06）:
//   - /api/translate system prompt: ~2700 → ~220 tokens（删除产品库/术语表/客户档案）
//   - /api/batch-translate-incoming system prompt: ~1100 → ~450 tokens（精简意图说明）
//   - 历史消息：限制到最近 3 条 × 100 字符
//   - 所有调用加 max_output_tokens 上限
//   - 新增 token 使用日志，input/output > 10:1 时输出 WARNING
//   - 安全网：保留旧 prompt 作为 expert 模式，可 per-request 或 env GWELL_TRANSLATE_DEFAULT_MODE=expert 回退
//   - 模型白名单：默认拒绝 gpt-4o / gpt-4.1 / o1 等昂贵模型（单价 16.7× mini），自动降级到 gpt-4o-mini
//                 env GWELL_ALLOW_PREMIUM_MODELS=true 可解除限制；典型日费用从 $1.55 → $0.10 量级

import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

if (!OPENAI_API_KEY) {
  console.warn("[gwell-backend] WARNING: OPENAI_API_KEY is not set; all translation routes will fail.");
}

// ============================================================
// Token 优化相关：默认翻译模式 / 历史限幅 / 日志
// ============================================================
// GWELL_TRANSLATE_DEFAULT_MODE:
//   "slim"   (默认) → 短 prompt，省 token，质量已通过 GWELL 身份/数字保留规则保证
//   "expert"        → 旧版长 prompt（含完整术语表），仅在发现 slim 翻译质量下降时使用
const DEFAULT_TRANSLATE_MODE =
  String(process.env.GWELL_TRANSLATE_DEFAULT_MODE || "slim").toLowerCase() === "expert" ? "expert" : "slim";
console.log(`[gwell-backend] default translate mode: ${DEFAULT_TRANSLATE_MODE}`);

// ============================================================
// 模型白名单（防止昂贵模型被默认调用，每年节省数百美元）
// ============================================================
// GWELL_ALLOW_PREMIUM_MODELS:
//   未设置 / "false" → 后端拒绝接受 gpt-4o / gpt-4.1 / o1 等高价模型，自动降级到 gpt-4o-mini
//   "true"          → 完全放行，相信客户端的 model 字段（紧急/高质量场景再开）
// 默认 false。这能彻底防止 Chrome 插件意外或刻意传 "gpt-4o" 导致单价瞬间放大 16.7 倍。
const ALLOW_PREMIUM_MODELS = String(process.env.GWELL_ALLOW_PREMIUM_MODELS || "").toLowerCase() === "true";
const FALLBACK_MODEL = "gpt-4o-mini";

// 公认便宜的 mini 系列（前缀匹配）
const ALLOWED_MINI_PREFIXES = [
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4_1-mini" // OpenAI dashboard 见过的别名形式
];

// 公认昂贵的 premium 系列（前缀匹配）—— 命中即降级（除非 ALLOW_PREMIUM_MODELS=true）
const PREMIUM_PREFIXES = [
  "gpt-4o-2024",
  "gpt-4o-2025",
  "gpt-4o-realtime",
  "gpt-4o-audio",
  "gpt-4o-search",
  "gpt-4.1-2025",
  "gpt-4-turbo",
  "gpt-4-",
  "chatgpt-4o-latest",
  "o1",
  "o3"
];

function isMiniModel(m) {
  const s = String(m || "").toLowerCase();
  return ALLOWED_MINI_PREFIXES.some((p) => s === p || s.startsWith(p + "-") || s.startsWith(p));
}

function isPremiumModel(m) {
  const s = String(m || "").toLowerCase();
  if (isMiniModel(s)) return false; // mini 系列优先
  return s === "gpt-4o" || s === "gpt-4.1" || s === "gpt-4" || PREMIUM_PREFIXES.some((p) => s.startsWith(p));
}

function enforceModelPolicy(requested, route) {
  const m = String(requested || "").trim();
  if (!m) return FALLBACK_MODEL;
  if (isMiniModel(m)) return m;
  if (isPremiumModel(m)) {
    if (ALLOW_PREMIUM_MODELS) {
      console.log(`[gwell-backend] [${route}] PREMIUM model "${m}" allowed by GWELL_ALLOW_PREMIUM_MODELS=true`);
      return m;
    }
    console.warn(`[gwell-backend] [${route}] BLOCKED premium model "${m}" → forced to "${FALLBACK_MODEL}" (set GWELL_ALLOW_PREMIUM_MODELS=true to permit)`);
    return FALLBACK_MODEL;
  }
  console.warn(`[gwell-backend] [${route}] UNKNOWN model "${m}" → forced to "${FALLBACK_MODEL}"`);
  return FALLBACK_MODEL;
}

console.log(`[gwell-backend] premium model policy: ${ALLOW_PREMIUM_MODELS ? "ALLOWED (GWELL_ALLOW_PREMIUM_MODELS=true)" : "BLOCKED → fallback to " + FALLBACK_MODEL}`);

// 历史消息上限（用于 /api/translate、/api/batch-translate-incoming）
const HISTORY_MAX_ITEMS = 3;
const HISTORY_MAX_CHARS = 100;

function clampHistory(messages, maxItems = HISTORY_MAX_ITEMS, maxChars = HISTORY_MAX_CHARS) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-maxItems)
    .map((m) => {
      if (typeof m === "string") {
        const t = m.replace(/\s+/g, " ").trim();
        return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
      }
      const text = String(m?.text || "").replace(/\s+/g, " ").trim();
      const clipped = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
      return { ...m, text: clipped };
    })
    .filter((m) => (typeof m === "string" ? m.length > 0 : String(m.text || "").length > 0));
}

function logUsage({ route, mode, inputChars, usage, model, withProducts = false, withHistory = false }) {
  const pt = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const ct = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const tt = usage?.total_tokens ?? (pt + ct);
  const ratio = ct > 0 ? pt / ct : Infinity;
  const ratioStr = isFinite(ratio) ? ratio.toFixed(2) : "inf";
  const warn = ct > 0 && ratio > 10 ? "  ⚠ WARNING: input tokens too high, check prompt/products/history." : "";
  console.log(
    [
      `[OpenAI Usage]`,
      `  route: ${route}` + (mode ? `  mode: ${mode}` : ""),
      `  inputChars: ${inputChars}`,
      `  promptTokens: ${pt}`,
      `  completionTokens: ${ct}`,
      `  totalTokens: ${tt}`,
      `  ratio (input:output): ${ratioStr}:1`,
      `  model: ${model}`,
      `  withProducts: ${withProducts}`,
      `  withHistory: ${withHistory}${warn}`
    ].join("\n")
  );
}

// ============================================================
// Products DB（启动时加载一次；仅 /quote 路由使用）
// ============================================================
let PRODUCTS = [];
try {
  const raw = readFileSync(join(__dirname, "products.json"), "utf8");
  PRODUCTS = JSON.parse(raw);
  console.log(`[gwell-backend] loaded ${PRODUCTS.length} products from products.json`);
} catch (err) {
  console.warn(`[gwell-backend] products.json not loaded (${err.code || err.message}); /quote will degrade to slim translation.`);
}

// ============================================================
// Local glossary（本地术语词典，启动时加载）
// 用法：编辑 local-glossary.json 添加新词条 → push → Railway 自动 redeploy 即生效
// 不命中任何词条时 0 token 开销；命中 N 条时仅追加 N 行参考块
// ============================================================
let GLOSSARY = [];
try {
  const raw = readFileSync(join(__dirname, "local-glossary.json"), "utf8");
  GLOSSARY = JSON.parse(raw);
  // 启动时一次性编译每个 pattern，运行时直接 test，避免每次请求重复构造 RegExp
  for (const entry of GLOSSARY) {
    entry._compiled = (Array.isArray(entry.patterns) ? entry.patterns : [])
      .map((pat) => {
        const p = String(pat || "").toLowerCase();
        if (!p) return null;
        if (/[\u4e00-\u9fff]/.test(p)) {
          return { type: "cjk", needle: p };
        }
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return { type: "re", re: new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i") };
      })
      .filter(Boolean);
  }
  console.log(`[gwell-backend] loaded ${GLOSSARY.length} glossary entries from local-glossary.json`);
} catch (err) {
  console.warn(`[gwell-backend] local-glossary.json not loaded (${err.code || err.message}); local term injection disabled.`);
}

function findGlossaryMatches(text) {
  if (!GLOSSARY.length || !text) return [];
  const lower = String(text).toLowerCase();
  const matches = [];
  for (const entry of GLOSSARY) {
    const compiled = entry._compiled || [];
    for (const c of compiled) {
      const hit = c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower);
      if (hit) {
        matches.push(entry);
        break;
      }
    }
  }
  return matches;
}

// 词典块按翻译方向单向化（双向格式 ↔ 会让模型分不清"该输出哪一侧"，
// 实测出现过把 "价格表" "箱数量" 等中文照抄进 Swahili 输出的情况）。
//   direction = "cn-to-foreign" : 中→外（用于 /api/translate），左侧中文，右侧外文
//   direction = "foreign-to-cn" : 外→中（用于 /api/batch-translate-incoming），左侧外文，右侧中文
function buildGlossaryBlock(matches, direction) {
  if (!matches || matches.length === 0) return "";
  const splitSides = (m) => {
    const all = Array.isArray(m.patterns) ? m.patterns : [];
    const cn = all.filter((p) => /[\u4e00-\u9fff]/.test(p));
    const fn = all.filter((p) => !/[\u4e00-\u9fff]/.test(p));
    return { cn, fn };
  };

  if (direction === "cn-to-foreign") {
    const lines = matches.map((m) => {
      const { cn, fn } = splitSides(m);
      const left = (cn[0] || m.zh).trim();
      const right = fn.length ? fn.join(" / ") : (m.en || m.zh);
      const note = m.note ? ` (${m.note})` : "";
      return `- ${left} → ${right}${note}`;
    });
    return `## Glossary (Chinese → target language)\nWhen these Chinese terms appear in the source, translate them as shown. Do NOT leave them in Chinese.\n${lines.join("\n")}\n\n`;
  }

  // foreign-to-cn (default for batch route)
  const lines = matches.map((m) => {
    const { fn } = splitSides(m);
    const left = fn.length ? fn.join(" / ") : (m.en || m.zh);
    const right = m.zh;
    const note = m.note ? ` (${m.note})` : "";
    return `- ${left} → ${right}${note}`;
  });
  return `## Glossary (foreign → Chinese)\nWhen these foreign-language terms appear in the source, translate them exactly as shown.\n${lines.join("\n")}\n\n`;
}

function searchProducts(text, max = 5) {
  if (!PRODUCTS.length || !text) return [];
  const s = String(text).toLowerCase();
  const tokens = s.split(/[\s,.;:!?\-/()\[\]{}"'`]+/).filter((t) => t.length >= 2);
  const scored = PRODUCTS.map((p) => {
    let score = 0;
    if (p.code && s.includes(String(p.code).toLowerCase())) score += 10;
    if (p.name && s.includes(String(p.name).toLowerCase())) score += 5;
    const kws = Array.isArray(p.keywords) ? p.keywords : [];
    for (const kw of kws) {
      const kwL = String(kw).toLowerCase();
      if (!kwL) continue;
      if (/^[\u4e00-\u9fff]/.test(kwL)) {
        if (s.includes(kwL)) score += 3;
      } else if (tokens.some((t) => t === kwL || t.includes(kwL))) {
        score += 2;
      }
    }
    return { product: p, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.product);
}

// ============================================================
// 本地意图关键词（命中即跳过 AI）
// ============================================================
const INTENT_KEYWORDS = {
  ask_price: [
    "bei", "bei gani", "price", "how much", "sh ngapi", "ngapi", "gharama", "cost",
    "bei yake", "bei ya jumla", "bei ya box", "wholesale price", "quotation", "quote",
    "报价", "价格", "多少钱", "批发价"
  ],
  ask_location: [
    "uko wapi", "mko wapi", "location", "address", "shop iko wapi", "duka liko wapi",
    "sehemu gani", "where are you", "mtaa gani",
    "位置", "地址", "你在哪里", "店在哪里"
  ],
  ask_payment: [
    "payment", "pay", "lipa", "malipo", "mpesa", "m-pesa", "tigopesa", "crdb", "nmb",
    "cash", "bank", "account",
    "付款", "收款", "银行", "账户", "转账"
  ],
  ask_delivery: [
    "delivery", "send", "ship", "transport", "mzigo", "usafiri", "basi", "cargo",
    "courier", "dispatch", "mnatuma",
    "发货", "运输", "物流", "送货"
  ],
  ask_stock: [
    "stock", "available", "unayo", "zipo", "ipo", "mna", "mzigo upo", "have stock",
    "库存", "有货", "现货"
  ],
  ask_product_info: [
    "model", "watt", "watts", "solar", "bulb", "torch", "fan", "kettle", "mosquito",
    "emergency", "sensor", "battery", "warranty",
    "型号", "功率", "太阳能", "灯泡", "手电", "风扇", "水壶", "电蚊拍", "应急", "传感器"
  ],
  ask_catalog_media: [
    "picha", "photo", "video", "catalog", "list", "price list",
    "图片", "图册", "视频", "目录", "价格表"
  ]
};

// 与 batch 路由保持同源的优先级（多类别命中时取首选）
const INTENT_PRIORITY = [
  "after_sales_complaint",
  "ask_location",
  "ask_price",
  "ask_stock",
  "ask_delivery",
  "ask_payment",
  "ask_product_info",
  "ask_catalog_media",
  "ask_visit_or_business",
  "customer_interested",
  "customer_not_interested",
  "other"
];

function localIntent(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return null;
  const hits = [];
  for (const [intent, kws] of Object.entries(INTENT_KEYWORDS)) {
    for (const kw of kws) {
      const kwL = kw.toLowerCase();
      let matched = false;
      if (/^[\u4e00-\u9fff]/.test(kwL)) {
        matched = s.includes(kwL);
      } else {
        const escaped = kwL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        matched = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(s);
      }
      if (matched) {
        hits.push({ intent, keyword: kw });
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => INTENT_PRIORITY.indexOf(a.intent) - INTENT_PRIORITY.indexOf(b.intent));
  return {
    intent: hits[0].intent,
    secondary_intents: hits.slice(1).map((h) => h.intent),
    confidence: "high",
    matched_keyword: hits[0].keyword,
    source: "local"
  };
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

function getReqUser(req) {
  return String(req.get("x-gwell-user") || "").trim();
}

function requireUser(req, res, next) {
  const user = getReqUser(req);
  req._user = user || null;

  if (!AUTH_ENABLED) {
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
async function callOpenAIResponses({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000,
  maxOutputTokens = null
}) {
  if (!OPENAI_API_KEY) throw new Error("Server missing OPENAI_API_KEY");
  if (!model) throw new Error("Missing model");

  const body = { model, instructions, input, temperature };
  if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
    body.max_output_tokens = maxOutputTokens;
  }
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

  return { text: String(text || "").trim(), usage: data.usage || null, raw: data };
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

// === SLIM 默认 prompt（~450 tokens）===
const BATCH_TRANSLATE_INSTRUCTIONS_SLIM = `You are a WhatsApp translator + intent classifier for GWELL, a lighting wholesaler in Dar es Salaam, Tanzania (Kariakoo office, Kigamboni factory). Customers write Swahili / English / French / mixed, often short with typos.

Input MAY start with a "== CONVERSATION CONTEXT ==" block — REFERENCE ONLY (the customer's recent prior messages). Do NOT translate it. Use it to resolve short cryptic items like "Vp", "Bei", "30W".

For each item:
1. translation_cn — Simplified Chinese.
   - Already Chinese / pure URL / pure emoji → "" (empty).
   - Cryptic short ("Vp","Hii","Ngp","Bei","30W") → use context to produce a COMPLETE Chinese sentence including the topic. NEVER output 2-char literals like "价"/"怎样".
   - If context empty AND item is a poke ("Vp") → "怎么样？/在吗？" with confidence=low.
2. intent (primary, one of the enum) + secondary_intents (others, max 3, [] if only one) + confidence.

INTENT ENUM (pick the closest)
- ask_location: where/address/street (wapi, mtaa, Kariakoo, Kigamboni)
- ask_price: bei, ngapi, jumla, qty, carton, wholesale, MOQ, promo
- ask_stock: in stock? (mna, ipo, available)
- ask_product_info: model/spec/feature (watts, taa, tochi, sola, sensor, battery, warranty)
- ask_catalog_media: picha, video, catalog, list
- ask_delivery: shipping incl. cross-border (mnatuma, mikoani, cargo, Congo/DRC/Zambia)
- ask_payment: Mpesa, TigoPesa, NMB, bank, cash
- ask_visit_or_business: kuja, sample, dealer, invoice, hours
- after_sales_complaint: imeharibika, haifanyi, return
- customer_interested: sawa, ndio, nataka, nachukua
- customer_not_interested: hapana, ghali, baadaye
- other: greetings, asante, emoji-only, unresolvable

PRIORITY when multiple match: complaint > location > price > stock > delivery > payment > product_info > catalog_media > visit > interested/not > other.

Confidence: high (clear) | medium (typos / 2 plausible intents) | low (too short / no context / garbled).

GWELL hints: Kariakoo=达市批发区, Kigamboni=GWELL 工厂区, ngp=ngapi, vp=vipi, nahii=na hii=这个呢.

Example: ctx=["Mna A60 LED bulb?"] item="Ngp" → translation_cn="A60 LED 球泡多少钱？" intent=ask_price.

Respond strictly with the JSON schema.`;

// === EXPERT 长 prompt（~1100 tokens；可通过 mode:"expert" 或 env 回退）===
const BATCH_TRANSLATE_INSTRUCTIONS_EXPERT = `You are a WhatsApp translator + intent classifier for GWELL, a Chinese lighting factory with office at Kariakoo (Dar es Salaam) and factory at Kigamboni. Customers are East-African buyers writing Swahili / English / Mixed, with typos, abbreviations and short messages.

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

// === SLIM 默认 outbound prompt（~220 tokens）===
// 保留：GWELL 身份(Kariakoo/Kigamboni)、数字/型号/单位保留规则、自然 WhatsApp 口吻、JSON 输出
// 删除：完整产品线列举、整张中→斯语术语表、客户档案
function buildOutboundInstructionsSlim({ overrideLanguage, contextHint }) {
  const phoneHint = contextHint && contextHint.phoneLangHint
    ? ` Phone-country hint suggests ${contextHint.phoneLangHint}.`
    : "";
  const detect = overrideLanguage
    ? `Target language is FORCED to "${overrideLanguage}". Use it as detectedLanguage with confidence "high" and detectionReason "manual override".`
    : `Detect the customer's primary language from their recent messages (Swahili / English / French / mixed). If unclear / emoji-only / empty → fall back to English.${phoneHint}`;

  return `You are a WhatsApp business translator for GWELL — a Chinese-owned lighting company with REAL local presence in Dar es Salaam, Tanzania (Office: Kariakoo, Factory: Kigamboni). Never imply "we are only in China / we ship from China" — we are physically in DAR.

INPUT
- A few recent customer messages (for language detection only — do NOT translate them).
- The salesperson's Chinese reply that needs translating.

TASKS
1. ${detect}
2. Translate the Chinese reply into that language naturally — like a real WhatsApp export salesperson, not stiff. For Swahili buyers, mixing common English business words (price, MOQ, container, sample, warranty, USD, TZS) is normal and PREFERRED.

PRESERVE EXACTLY
- Numbers and units (W, V, K, lm, mAh, USD, TZS, %, mm, kg)
- Product codes / models (A60, A70, T8, E27, B22, GL-xxxx, etc.)
- URLs, phone numbers, emojis, line breaks

HARD RULE — NO CHINESE IN OUTPUT
- The translated message must contain ZERO Chinese characters (no Hanzi at all).
- Translate every Chinese word, including compounds like 价格表, 箱数量, 批发价, 现货, 库存, 报价单, 起订量 — render them in the target language, never copy them as-is.
- If a Chinese word is also in the Glossary block, use the glossary mapping.

OUTPUT
- Translation only — no quotes, no "Translation:" prefix, no markdown.

Respond strictly with the JSON schema provided.`;
}

// === EXPERT 长 prompt（~2700 tokens；保留作 mode:"expert" 后备 / 质量回退）===
function buildOutboundInstructionsExpert({ overrideLanguage, contextHint }) {
  const cust = contextHint || {};
  const custLines = [];
  if (cust.name) custLines.push(`- Saved name / chat title: ${cust.name}`);
  if (cust.phone) custLines.push(`- Phone: ${cust.phone}`);
  if (cust.phoneLangHint) custLines.push(`- Phone country hint: likely ${cust.phoneLangHint}`);
  if (cust.subtitle) custLines.push(`- Status line: ${cust.subtitle}`);

  return `You are an expert translator working for GWELL, a Chinese lighting factory exporting to Tanzania and East Africa via WhatsApp Business.

You will receive:
  - The customer's most recent messages (so you can identify their language).
  - The salesperson's Chinese reply that needs to be translated.

Tasks:
1. ${
    overrideLanguage
      ? `The target language is FORCED to be "${overrideLanguage}". Use this as detectedLanguage with confidence "high" and detectionReason "manual override".`
      : `Detect the customer's primary language from their recent messages. If they only sent emojis / very short text / no messages, use the phone country hint (if provided), otherwise fall back to English. Pick the dominant language if mixed.`
  }
2. Translate the Chinese reply into that language.

== BUSINESS PROFILE ==
GWELL = Chinese-owned lighting company with REAL LOCAL PRESENCE in Tanzania.
- 公司总部 / China HQ: Chinese lighting manufacturer
- Tanzania 办公室 / Office: Kariakoo, Dar es Salaam
- Tanzania 工厂 / Factory: Kigamboni, Dar es Salaam
When translating Chinese replies that mention our location, always use the above addresses confidently (do NOT say "我们只在中国" / "we only ship from China" — we are physically in DAR).

Product lines:
- LED bulbs (A60/A70/A100, E27/B22 base)
- LED tube lights (T5/T8, 0.6m/0.9m/1.2m)
- Torches / flashlights (rechargeable, aluminum/plastic)
- Emergency lights (rechargeable, wall-mount)
- Solar products (solar home systems 1-to-3 / 1-to-5, solar street lights, solar flood lights, solar lanterns)
- Rechargeable fans (with built-in LED)
- Mosquito killer lamps (UV electric)
- Outdoor: flood lights, street lights, garden lights, security lights with motion sensor
- LED panel lights, downlights, ceiling lights, work lights, headlamps

Typical customer profile: Tanzania-based distributor / wholesaler / retail shop / project contractor. They visit Kariakoo office for samples, place container orders, ask about prices, MOQ, lead time, payment terms, samples, packaging, certificates.

== LOCATION TERMINOLOGY (Chinese → Swahili) ==
- 我们在达累斯萨拉姆 / 我们在 DAR → Tupo Dar es Salaam
- 办公室在 Kariakoo → Tuna ofisi Kariakoo / Ofisi yetu ipo Kariakoo
- 工厂在 Kigamboni → Tuna factory Kigamboni / Kiwanda chetu kipo Kigamboni
- 我发位置给你 → Nitakutumia location sasa hivi
- 欢迎过来 → Karibu sana
- 今天可以来吗 → Unataka kuja leo?
- 明天 → kesho
- 地址 / 位置 → location / anwani / mahali
- 哪条街 → mtaa gani
- 哪栋楼 → jengo gani
- 靠近 X → karibu na X
- 附近 → karibu / jirani

== CHINESE → SWAHILI/ENGLISH TERMINOLOGY (use these mappings) ==
Products:
- 灯 / 灯具 → taa
- 灯泡 / LED 灯泡 → balbu / balbu ya LED
- 球泡 → balbu (round bulb)
- 灯管 → taa ya tube / tube light
- 手电筒 → tochi
- 应急灯 → taa ya dharura / emergency light
- 太阳能灯 → taa ya sola
- 太阳能板 → paneli ya sola / solar panel
- 太阳能一拖三 / 一拖五 → solar system 1-to-3 / 1-to-5 (English preferred, customers know it)
- 充电灯 → taa ya kuchaji / rechargeable light
- 充电小风扇 → feni ya kuchaji / rechargeable fan
- 灭蚊灯 → taa ya kuua mbu / mosquito killer
- 投光灯 / 泛光灯 → flood light
- 路灯 → taa ya barabarani / street light
- 工矿灯 → high-bay light
- 头灯 → headlamp
- 筒灯 / 射灯 → downlight / spotlight
- 吸顶灯 → ceiling light

Technical specs (KEEP IN ENGLISH/NUMBERS — customers expect):
- 瓦数 / 功率 → W (e.g. 9W, 30W)
- 电压 → V (e.g. 220V, 12V)
- 流明 → lumens / lm
- 色温 → 3000K (warm white) / 6500K (cool white / daylight)
- 显色指数 → CRI
- 防水 → IP65 / IP67
- 灯头 → E27 / B22 / E14
- 充电时间 → charging time
- 续航 → backup time / working hours
- 电池容量 → mAh / battery capacity
- 太阳能板瓦数 → Wp

Commercial / logistics:
- 价格 → bei / price
- 批发价 → wholesale price / bei ya jumla
- 零售价 → retail price / bei ya rejareja
- 起订量 / MOQ → MOQ (English, universal)
- 整箱 / 一箱 → katoni / 1 carton
- 内盒 → inner box
- 外箱 → master carton
- 包装 → packing
- 彩盒 → color box
- 中性包装 → neutral packing
- OEM / 贴牌 → OEM
- 货期 / 交期 → lead time / delivery time
- 整柜 / 集装箱 → container / kontena (20'GP, 40'GP, 40'HQ)
- 海运 → by sea / sea freight
- 空运 → by air
- 港口 → bandari (Dar es Salaam port)
- 出货 → ship / delivery
- 样品 → sample / sampuli
- 样品费 → sample charge
- 保修 / 质保 → warranty (typically 1 year / 2 years)
- 认证 → certificates (CE / RoHS / TUV / EAC for East African Community)
- 付款方式 → payment terms
- 30%订金 70%尾款 → 30% deposit + 70% balance before shipment
- TT / 电汇 → T/T
- 信用证 → L/C
- 美金 → USD
- 坦桑先令 → TZS

Style rules:
- Friendly, natural, business-appropriate for WhatsApp — like a real export salesperson, not stiff.
- For Swahili customers, mixing common English business words (price, order, MOQ, container, USD, sample, warranty) is normal and PREFERRED over forced literal translation.
- Add appropriate greeting/closing if Chinese source has it (e.g. "您好" → "Habari" or "Hello dear"; "祝好" → "Thanks & regards").
- Preserve line breaks, numbers, units (W, V, lm, K, kg, mm, USD, TZS, %), product codes/SKUs, emojis, URLs, @mentions, phone numbers exactly.
- Translate the *meaning* of Chinese idioms, never word-for-word.
- Output the translation only — no quotes, no "Translation:" prefix, no markdown fences.

${custLines.length ? `Additional context about the customer (for tone calibration; do NOT mention them in the translation):\n${custLines.join("\n")}\n` : ""}
Respond strictly with the JSON schema provided.`;
}

function buildOutboundInput({ customerMessages, sourceText }) {
  const clamped = clampHistory(customerMessages);
  const combined = [
    sourceText,
    ...clamped.map((m) => (typeof m === "string" ? m : String(m.text || "")))
  ].filter(Boolean).join("\n");
  const glossaryBlock = buildGlossaryBlock(findGlossaryMatches(combined), "cn-to-foreign");

  const lines = [];
  if (glossaryBlock) lines.push(glossaryBlock);
  lines.push(`## Customer recent messages (oldest → newest, max ${HISTORY_MAX_ITEMS} × ${HISTORY_MAX_CHARS} chars)`);
  if (clamped.length === 0) {
    lines.push("(none — no incoming messages were readable from the current chat)");
  } else {
    clamped.forEach((m, i) => {
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

app.get("/api/health", (req, res) => {
  const user = getReqUser(req);
  let authorized;
  if (!AUTH_ENABLED) authorized = true;
  else if (!user) authorized = false;
  else authorized = ALLOWED_USERS.has(user);

  res.json({
    ok: true,
    hasKey: !!OPENAI_API_KEY,
    authEnabled: AUTH_ENABLED,
    allowedCount: AUTH_ENABLED ? ALLOWED_USERS.size : 0,
    yourUser: user || null,
    authorized,
    defaultTranslateMode: DEFAULT_TRANSLATE_MODE,
    allowPremiumModels: ALLOW_PREMIUM_MODELS,
    fallbackModel: FALLBACK_MODEL,
    glossaryEntries: GLOSSARY.length
  });
});

// === 主路由 1：outbound 中→客户语言 ===
// 默认 slim prompt（~220 tokens）；可 per-request `mode:"expert"` 或 env GWELL_TRANSLATE_DEFAULT_MODE 回退。
app.post("/api/translate", requireUser, async (req, res) => {
  try {
    const {
      sourceText,
      customerMessages = [],
      overrideLanguage = null,
      contextHint = null,
      model: requestedModel = FALLBACK_MODEL,
      mode: reqMode
    } = req.body || {};

    const src = String(sourceText || "").trim();
    if (!src) return res.status(400).json({ ok: false, error: "EMPTY_SOURCE" });

    const model = enforceModelPolicy(requestedModel, "/api/translate");
    const modelDowngraded = model !== requestedModel;

    const mode = (String(reqMode || DEFAULT_TRANSLATE_MODE).toLowerCase() === "expert") ? "expert" : "slim";
    const instructions = mode === "expert"
      ? buildOutboundInstructionsExpert({ overrideLanguage, contextHint })
      : buildOutboundInstructionsSlim({ overrideLanguage, contextHint });
    const input = buildOutboundInput({ customerMessages, sourceText: src });

    const { text, usage } = await callOpenAIResponses({
      model,
      instructions,
      input,
      jsonSchema: TRANSLATE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 300
    });

    logUsage({
      route: "/api/translate",
      mode,
      inputChars: instructions.length + input.length,
      usage,
      model,
      withProducts: false,
      withHistory: Array.isArray(customerMessages) && customerMessages.length > 0
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

    res.json({
      ok: true,
      ...parsed,
      usage,
      model,
      mode,
      requestedModel,
      modelDowngraded
    });
  } catch (err) {
    console.error("[/api/translate]", err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      requestedModel: req.body?.model ?? null
    });
  }
});

// === 主路由 2：批量来信 → 中文 + 意图 + auto-upgrade ===
app.post("/api/batch-translate-incoming", requireUser, async (req, res) => {
  try {
    const {
      items: rawItems,
      recentContext: rawCtx = [],
      model: requestedModel = FALLBACK_MODEL,
      upgradeModel: requestedUpgradeModel = null,
      mode: reqMode
    } = req.body || {};

    const items = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
    if (items.length === 0) return res.json({ ok: true, translations: [] });

    const model = enforceModelPolicy(requestedModel, "/api/batch-translate-incoming");
    const upgradeModel = requestedUpgradeModel
      ? enforceModelPolicy(requestedUpgradeModel, "/api/batch-translate-incoming.upgrade")
      : null;
    const modelDowngraded = model !== requestedModel || (requestedUpgradeModel && upgradeModel !== requestedUpgradeModel);

    const mode = (String(reqMode || DEFAULT_TRANSLATE_MODE).toLowerCase() === "expert") ? "expert" : "slim";
    const batchInstructions = mode === "expert"
      ? BATCH_TRANSLATE_INSTRUCTIONS_EXPERT
      : BATCH_TRANSLATE_INSTRUCTIONS_SLIM;

    const recentContext = clampHistory(
      (Array.isArray(rawCtx) ? rawCtx : []).map((s) => String(s || "").replace(/\r?\n/g, " ").trim()).filter(Boolean)
    ).map((m) => (typeof m === "string" ? m : m.text));

    let contextBlock = "";
    if (recentContext.length) {
      const ctxLines = recentContext.map((t, i) => `${i + 1}. ${t}`).join("\n");
      contextBlock =
`== CONVERSATION CONTEXT (recent customer messages, max ${HISTORY_MAX_ITEMS} × ${HISTORY_MAX_CHARS} chars) ==
REFERENCE ONLY — do NOT translate. Use only to resolve pointing words ("hii","nahii","iyo"),
bare specs ("30W","E27"), and short questions ("Bei?","Ngapi?","Vp").

${ctxLines}

== END CONTEXT ==

`;
    }

    // 输出 token 上限：每条 ~80 token，最少 200，最多 1500
    const perItemOutput = 80;
    const maxOutputTokens = Math.min(Math.max(items.length * perItemOutput, 200), 1500);

    async function callBatchOnce({ model: m, items: subItems }) {
      const subLines = subItems.map((it, idx) => {
        const safeText = String(it.text || "").replace(/\r?\n/g, "\n");
        return `[item ${idx + 1}] id=${it.id}\n${safeText}`;
      });
      const glossarySource = [
        ...subItems.map((it) => String(it.text || "")),
        ...recentContext
      ].join("\n");
      const glossaryBlock = buildGlossaryBlock(findGlossaryMatches(glossarySource), "foreign-to-cn");
      const subInput =
`${glossaryBlock}${contextBlock}Translate the following ${subItems.length} foreign-language customer message(s) into Simplified Chinese.

${subLines.join("\n\n---\n\n")}`;
      const { text, usage } = await callOpenAIResponses({
        model: m,
        instructions: batchInstructions,
        input: subInput,
        jsonSchema: BATCH_TRANSLATE_SCHEMA,
        temperature: 0.2,
        timeoutMs: 60000,
        maxOutputTokens: Math.min(Math.max(subItems.length * perItemOutput, 200), 1500)
      });
      logUsage({
        route: "/api/batch-translate-incoming",
        mode,
        inputChars: batchInstructions.length + subInput.length,
        usage,
        model: m,
        withProducts: false,
        withHistory: recentContext.length > 0
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
          const retry = await callBatchOnce({ model: upgradeModel, items: retryItems });
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
      upgradeModel: canUpgrade ? upgradeModel : null,
      mode,
      requestedModel,
      requestedUpgradeModel,
      modelDowngraded
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
        max_tokens: 300,
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
    logUsage({
      route: "/translate",
      mode: "legacy",
      inputChars: String(text).length,
      usage: data?.usage,
      model: "gpt-4.1-mini",
      withProducts: false,
      withHistory: false
    });
    res.json({ translation: data?.choices?.[0]?.message?.content || "" });
  } catch (error) {
    console.error("[/translate]", error);
    res.status(500).json({ error: "Translation failed" });
  }
});

// === 新路由：意图识别（本地关键词优先；命中即返回，不调用 AI）===
const INTENT_AI_INSTRUCTIONS = `Classify the customer's WhatsApp message into ONE intent:
ask_location | ask_price | ask_stock | ask_product_info | ask_catalog_media | ask_delivery | ask_payment | ask_visit_or_business | after_sales_complaint | customer_interested | customer_not_interested | other

Return ONLY the intent name, nothing else. Lowercase. No explanation. No JSON.`;

app.post("/intent", requireUser, async (req, res) => {
  try {
    const { text } = req.body || {};
    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ ok: false, error: "EMPTY_TEXT" });

    // 1) 本地规则优先
    const local = localIntent(t);
    if (local) {
      return res.json({
        ok: true,
        ...local,
        usedAI: false
      });
    }

    // 2) 本地未命中 → 极小 AI 调用
    if (!OPENAI_API_KEY) {
      return res.json({ ok: true, intent: "other", confidence: "low", source: "fallback", usedAI: false });
    }

    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 20,
        messages: [
          { role: "system", content: INTENT_AI_INSTRUCTIONS },
          { role: "user", content: t.slice(0, 200) }
        ]
      })
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: `OpenAI ${r.status}: ${bodyText.slice(0, 200)}` });
    }
    const data = await r.json();
    const raw = String(data?.choices?.[0]?.message?.content || "other").trim().toLowerCase();
    const intent = INTENT_PRIORITY.includes(raw) ? raw : "other";

    logUsage({
      route: "/intent",
      mode: "ai-fallback",
      inputChars: INTENT_AI_INSTRUCTIONS.length + t.length,
      usage: data?.usage,
      model: "gpt-4o-mini",
      withProducts: false,
      withHistory: false
    });

    res.json({
      ok: true,
      intent,
      secondary_intents: [],
      confidence: "medium",
      source: "ai",
      usedAI: true
    });
  } catch (err) {
    console.error("[/intent]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === 新路由：报价/产品 —— 本地搜索匹配 1-5 条产品后再调用 AI ===
// 仅这个路由允许把产品资料注入 prompt。即使本地搜索失败，也只回退到无产品的 slim 翻译，绝不发送整个产品库。
app.post("/quote", requireUser, async (req, res) => {
  try {
    const {
      text,
      targetLanguage = null,
      customerMessages = [],
      model: requestedModel = FALLBACK_MODEL
    } = req.body || {};

    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ ok: false, error: "EMPTY_TEXT" });

    const model = enforceModelPolicy(requestedModel, "/quote");
    const modelDowngraded = model !== requestedModel;

    const matches = searchProducts(t, 5);
    const history = clampHistory(customerMessages);

    let productBlock = "";
    if (matches.length > 0) {
      productBlock =
`## Matched products (max 5)
${matches.map((p, i) => `${i + 1}. ${p.code} — ${p.name}\n   specs: ${p.specs}\n   packing: ${p.packing}`).join("\n")}

`;
    }

    let historyBlock = "";
    if (history.length > 0) {
      historyBlock =
`## Recent customer messages (oldest → newest, ref only)
${history.map((m, i) => `${i + 1}. ${typeof m === "string" ? m : m.text}`).join("\n")}

`;
    }

    const detect = targetLanguage
      ? `Target language is forced to "${targetLanguage}" (confidence=high, reason="manual override").`
      : `Detect customer's primary language from their messages (Swahili / English / French / mixed). If unclear/empty → English.`;

    const instructions = `You are a WhatsApp sales assistant for GWELL — a lighting wholesaler in Dar es Salaam, Tanzania (Kariakoo office, Kigamboni factory).

The customer is asking about price / stock / product info. Use ONLY the matched products listed in the input — do NOT invent codes or specs. If no matched products are listed, answer in a generic helpful way and ask for clarification (model, watts, qty).

TASKS
1. ${detect}
2. Compose a concise WhatsApp reply in that language quoting the matched product(s) (code, key spec, packing). For Swahili buyers, mixing English business words (price, MOQ, carton, USD) is preferred.
3. Preserve numbers, units (W, V, K, mAh, USD, TZS, %), product codes, URLs, phone numbers exactly.
4. Output the reply text only — no quotes, no "Reply:" prefix, no markdown, no JSON.`;

    const input = `${historyBlock}${productBlock}## Customer question
${t}`;

    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "Server missing OPENAI_API_KEY" });

    const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: input }
        ]
      })
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: `OpenAI ${r.status}: ${bodyText.slice(0, 200)}` });
    }
    const data = await r.json();
    logUsage({
      route: "/quote",
      mode: "default",
      inputChars: instructions.length + input.length,
      usage: data?.usage,
      model,
      withProducts: matches.length > 0,
      withHistory: history.length > 0
    });

    res.json({
      ok: true,
      reply: data?.choices?.[0]?.message?.content || "",
      matchedProducts: matches.map((p) => ({ code: p.code, name: p.name })),
      usage: data?.usage,
      model,
      requestedModel,
      modelDowngraded
    });
  } catch (err) {
    console.error("[/quote]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
