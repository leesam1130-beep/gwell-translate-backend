// GWELL Translate Backend
// 给 Chrome 扩展 (gwell-wa-crm-extension) 提供翻译 API 代理服务。
// 双 provider 架构：默认 Google Gemini（gemini-2.0-flash），OpenAI 当容灾备份。
// 任一 provider 失败/被安全过滤拦截时自动切到另一家。
// API Keys 仅保存在服务端环境变量，插件端不再持有任何密钥。
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

// --- Google Gemini（默认主 provider，OpenAI 当容灾备份）---
// 若想反过来：env GWELL_PRIMARY_PROVIDER=openai
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_BASE_URL = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
// 注：2026-06 起 gemini-2.0-flash / 1.5 系列全部 EOL，用 2.5 系列。
//     gemini-2.5-flash       — 平衡款（默认推荐）
//     gemini-2.5-flash-lite  — 更便宜更快，质量稍弱
//     gemini-2.5-pro         — 最强但贵 8x，翻译用不上
//
// 自动 EOL 防错：若 env 仍然填的是已退役模型，强制升级到 2.5-flash 并打 warning。
// 这样不需要用户去 Railway 改环境变量。
const DEPRECATED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash-002",
  "gemini-1.5-pro",
  "gemini-1.5-pro-002",
  "gemini-1.0-pro",
  "gemini-pro"
]);
const _RAW_GEMINI_MODEL = (process.env.GWELL_GEMINI_MODEL || "gemini-2.5-flash").toLowerCase().trim();
const GEMINI_DEFAULT_MODEL = DEPRECATED_GEMINI_MODELS.has(_RAW_GEMINI_MODEL)
  ? "gemini-2.5-flash"
  : _RAW_GEMINI_MODEL;
if (_RAW_GEMINI_MODEL !== GEMINI_DEFAULT_MODEL) {
  console.warn(
    `[gwell-backend] WARNING: GWELL_GEMINI_MODEL="${_RAW_GEMINI_MODEL}" is EOL/deprecated → auto-upgraded to "${GEMINI_DEFAULT_MODEL}". Please update Railway env var to silence this warning.`
  );
}
const PRIMARY_PROVIDER =
  String(process.env.GWELL_PRIMARY_PROVIDER || "gemini").toLowerCase() === "openai" ? "openai" : "gemini";

if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
  console.warn("[gwell-backend] WARNING: neither OPENAI_API_KEY nor GEMINI_API_KEY is set; all translation routes will fail.");
} else if (!OPENAI_API_KEY) {
  console.warn("[gwell-backend] OPENAI_API_KEY missing — OpenAI fallback disabled (only Gemini will be tried).");
} else if (!GEMINI_API_KEY) {
  console.warn("[gwell-backend] GEMINI_API_KEY missing — Gemini fallback disabled (only OpenAI will be tried).");
}
console.log(`[gwell-backend] primary provider: ${PRIMARY_PROVIDER} (Gemini default model: ${GEMINI_DEFAULT_MODEL})`);

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

// 历史消息上限
// - outbound (/api/translate)：历史只用于"语言检测"，2 条足够，更短的字符限避免长消息冲淡
// - inbound batch：历史是消解 "Vp"/"Bei"/"30W" 等省略式所必需，保持 3×100
const OUTBOUND_HISTORY_MAX_ITEMS = 2;
const OUTBOUND_HISTORY_MAX_CHARS = 80;
const HISTORY_MAX_ITEMS = 3;     // 默认值；batch 路由用
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

function logUsage({
  route,
  mode,
  inputChars,
  usage,
  model,
  withProducts = false,
  withHistory = false,
  provider = "openai",
  providerFallback = false,
  targetLanguage = null,
  targetSource = null
}) {
  const pt = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const ct = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const tt = usage?.total_tokens ?? (pt + ct);
  const ratio = ct > 0 ? pt / ct : Infinity;
  const ratioStr = isFinite(ratio) ? ratio.toFixed(2) : "inf";
  const warn = ct > 0 && ratio > 10 ? "  ⚠ WARNING: input tokens too high, check prompt/products/history." : "";
  const tag = provider === "gemini" ? "Gemini Usage" : "OpenAI Usage";
  const fallbackNote = providerFallback ? "  ⚠ provider fallback (primary failed)" : "";
  console.log(
    [
      `[${tag}]${fallbackNote}`,
      `  route: ${route}` + (mode ? `  mode: ${mode}` : ""),
      `  inputChars: ${inputChars}`,
      `  promptTokens: ${pt}`,
      `  completionTokens: ${ct}`,
      `  totalTokens: ${tt}`,
      `  ratio (input:output): ${ratioStr}:1`,
      `  model: ${model}`,
      `  withProducts: ${withProducts}`,
      `  withHistory: ${withHistory}` + (targetLanguage ? `  target: ${targetLanguage} (${targetSource})` : "") + warn
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

// TOP-N cap：词典命中过多时（一次中文回复可能命中 15+ 条，含 价格/箱/货 这种短而通用的），
// 按"被命中的 pattern 长度"降序保留前 N 条 —— 长 pattern 更具体（"价格表" > "价格"），
// 携带的信息密度更高，模型也更需要它们。N=6 足够覆盖常见业务场景。
const GLOSSARY_MATCH_CAP = 6;

function findGlossaryMatches(text) {
  if (!GLOSSARY.length || !text) return [];
  const lower = String(text).toLowerCase();
  const scored = [];
  for (const entry of GLOSSARY) {
    const compiled = entry._compiled || [];
    let matchedLen = 0;
    for (const c of compiled) {
      const hit = c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower);
      if (hit) {
        const l = c.type === "cjk" ? c.needle.length : c.re.source.length;
        if (l > matchedLen) matchedLen = l;
      }
    }
    if (matchedLen > 0) scored.push({ entry, matchedLen });
  }
  scored.sort((a, b) => b.matchedLen - a.matchedLen);
  return scored.slice(0, GLOSSARY_MATCH_CAP).map((s) => s.entry);
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
    return `## Glossary (Chinese → foreign variants; advisory)\nVariants may be Swahili-only, English-only, or both. ONLY use a variant that matches your chosen target language. If no variant matches the target, IGNORE the entry and translate the Chinese term fresh — never mix languages in the output.\n${lines.join("\n")}\n\n`;
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
// Google Gemini provider —— 与 callOpenAIResponses 同签名同返回结构
// ============================================================
//
// Gemini 不接受 OpenAI 的 JSON Schema 全集，需要剥掉以下字段：
//   - additionalProperties / $schema / strict   (Gemini 拒绝识别)
//   - 外层 { name, strict, schema } 包装        (只取 .schema)
// 其余 type/properties/required/items/enum/description/nullable 都兼容。
// 从一段（可能截断的）JSON 文本里抢救出 "fieldName":"..." 的字符串值。
// 用 JSON.parse 重新合法化转义；抢救失败返回 ""，调用方决定是否报错。
// 用途：模型输出被 max_output_tokens 截断时，至少救出 translation 字段，
// 而不是把整段烂 JSON 串塞回前端。
function extractJsonStringField(text, fieldName) {
  if (!text || typeof text !== "string") return "";
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
  const m = text.match(re);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1] || "";
  }
}

function convertSchemaForGemini(jsonSchema) {
  if (!jsonSchema) return null;
  const root = jsonSchema.schema || jsonSchema;
  const STRIP = new Set(["additionalProperties", "$schema", "strict", "name"]);
  const walk = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (STRIP.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(root);
}

async function callGeminiResponses({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000,
  maxOutputTokens = null,
  thinkingBudget = undefined  // undefined = let Gemini default; 0 = disable; N = cap at N tokens
}) {
  if (!GEMINI_API_KEY) throw new Error("Server missing GEMINI_API_KEY");
  if (!model) throw new Error("Missing model");

  const generationConfig = { temperature };
  if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = maxOutputTokens;
  }
  if (jsonSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = convertSchemaForGemini(jsonSchema);
  }
  // Thinking budget 策略（2026-06 实测）：
  //   • thinkingBudget = 0 → 完全关掉思考。最快、最便宜。
  //                          适用于 BATCH 那种"翻译一段就完事"的扁平任务。
  //   • thinkingBudget = N → 给 N token 思考空间。
  //                          适用于 OUTBOUND（需要先 detect 语言、再翻译、再产 JSON 三字段）
  //                          这种结构化任务。N=0 时模型会乱答（实测 sourceText 被无视、
  //                          回答客户消息里的问题；或输出 ????????）。
  //   • undefined → 不传 thinkingConfig，模型默认（一般 1024 token），够用但偶尔超 max_output。
  if (typeof thinkingBudget === "number" && thinkingBudget >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: input }] }],
    generationConfig
  };
  if (instructions) {
    body.systemInstruction = { parts: [{ text: instructions }] };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") throw new Error(`Gemini timeout (${timeoutMs}ms)`);
    throw new Error("Gemini network error: " + (err?.message || String(err)));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let raw = "";
    try { raw = await res.text(); } catch {}
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    const msg = parsed?.error?.message || raw.slice(0, 300) || res.statusText;
    const e = new Error(`Gemini ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  // Gemini 安全过滤命中或 finishReason 异常时（SAFETY / RECITATION / OTHER），
  // candidate.content.parts 可能为空 → 抛错触发 OpenAI 容灾。
  const finishReason = candidate?.finishReason || "";
  if (!candidate || (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS")) {
    const e = new Error(`Gemini blocked or empty response (finishReason=${finishReason || "none"})`);
    e.status = 422;
    throw e;
  }

  let text = "";
  if (candidate?.content?.parts) {
    for (const p of candidate.content.parts) {
      if (typeof p.text === "string") text += p.text;
    }
  }

  // 把 Gemini 的 usageMetadata 映射成 OpenAI 风格，让 logUsage 直接复用
  const um = data.usageMetadata || {};
  const usage = {
    input_tokens: um.promptTokenCount || 0,
    output_tokens: um.candidatesTokenCount || 0,
    total_tokens: um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)),
    prompt_tokens: um.promptTokenCount || 0,
    completion_tokens: um.candidatesTokenCount || 0
  };

  return { text: String(text || "").trim(), usage, raw: data };
}

// ============================================================
// Provider 路由器 —— 主选 Gemini，失败容灾到 OpenAI（或反之）
// ============================================================
function isGeminiModel(m) {
  return /^gemini[-_]/i.test(String(m || ""));
}

function isOpenAIModel(m) {
  const s = String(m || "").toLowerCase();
  return s.startsWith("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("chatgpt");
}

// 客户端可能传：
//   - "gemini-2.0-flash"     → 强制 Gemini
//   - "gpt-4o-mini"          → 强制 OpenAI（再走 enforceModelPolicy 防止误传 premium）
//   - 空 / 不识别            → 用 PRIMARY_PROVIDER 默认
function resolveProviderModel(requestedModel, route) {
  if (isGeminiModel(requestedModel)) {
    return { provider: "gemini", model: String(requestedModel) };
  }
  if (isOpenAIModel(requestedModel)) {
    return { provider: "openai", model: enforceModelPolicy(requestedModel, route) };
  }

  // 路由级 provider 策略（2026-06 实测）：
  //   • /api/translate (outbound) — 结构化任务（detect 语言 + 翻译 + JSON 三字段）。
  //     Gemini 2.5-flash 在这种任务下不稳：
  //        - thinkingBudget=0 → 把 customerMessages 当对话续写，无视 sourceText
  //        - thinkingBudget=default → 偶尔输出空字符串或 "Sijaelewa?"
  //     OpenAI gpt-4o-mini 在这种任务上一直稳定。所以 outbound 默认强制 OpenAI。
  //   • /api/batch-translate-incoming — 扁平任务（每条客户消息翻成中文）。
  //     Gemini 2.5-flash 实测好用、便宜（每千次调用比 OpenAI 省 70%）。继续用。
  //   用户可通过 GWELL_OUTBOUND_PROVIDER=gemini 强制切回 Gemini（实验性）。
  const outboundOverride = String(process.env.GWELL_OUTBOUND_PROVIDER || "").toLowerCase();
  let routePrimary;
  if (route === "/api/translate") {
    routePrimary = outboundOverride === "gemini" ? "gemini" : "openai";
  } else {
    routePrimary = PRIMARY_PROVIDER;
  }

  if (routePrimary === "gemini") {
    return { provider: "gemini", model: GEMINI_DEFAULT_MODEL };
  }
  return { provider: "openai", model: enforceModelPolicy(requestedModel, route) };
}

async function callTranslateAPI({ provider, model, ...rest }) {
  const fallbackProvider = provider === "gemini" ? "openai" : "gemini";
  const fallbackHasKey = fallbackProvider === "gemini" ? !!GEMINI_API_KEY : !!OPENAI_API_KEY;
  const fallbackModel = fallbackProvider === "gemini" ? GEMINI_DEFAULT_MODEL : FALLBACK_MODEL;

  const callOnce = (p, m) =>
    p === "gemini"
      ? callGeminiResponses({ ...rest, model: m })
      : callOpenAIResponses({ ...rest, model: m });

  try {
    const r = await callOnce(provider, model);
    return { ...r, provider, modelUsed: model, providerFallback: false };
  } catch (err) {
    if (!fallbackHasKey) throw err;
    console.warn(
      `[provider-fallback] ${provider}/${model} failed: ${err?.message || err} → retry ${fallbackProvider}/${fallbackModel}`
    );
    const r = await callOnce(fallbackProvider, fallbackModel);
    return {
      ...r,
      provider: fallbackProvider,
      modelUsed: fallbackModel,
      providerFallback: true,
      primaryError: String(err?.message || err)
    };
  }
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
            translation_cn: { type: "string" }
          },
          required: ["id", "translation_cn"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};

// === SLIM 默认 prompt（~180 tokens）===
// 用户决定意图自己分析，prompt 砍掉 12-intent 分类、PRIORITY、confidence 等，
// 只负责把 foreign 翻成中文。
const BATCH_TRANSLATE_INSTRUCTIONS_SLIM = `WhatsApp translator for GWELL (lighting wholesaler in Dar es Salaam — Kariakoo office, Kigamboni factory). Customers write Swahili/English/French/mixed, short, typos.

Input may start with "== CONVERSATION CONTEXT ==" — REFERENCE ONLY (do NOT translate). Use it to resolve cryptic items ("Vp"/"Bei"/"30W").

For each item, output translation_cn in Simplified Chinese:
- Already Chinese / pure URL / pure emoji → ""
- Acknowledgment ("Ok","OK","Okay","Sawa","Ndio","Yes") → "好的"  (NEVER "怎么样")
- Greeting ("Hi","Hello","Mambo","Habari") → "你好"
- Thanks ("Asante","Asante sana") → "谢谢" / "非常感谢"
- Cryptic short ("Vp","Bei","30W") → use context to produce a COMPLETE Chinese sentence (never 2-char literals like "价"/"怎样")
- Empty-context poke ("Vp" only, NOT "Ok") → "怎么样？/在吗？"

Hints: ngp=ngapi, vp=vipi, nahii=this one, caton=carton=箱, nusu carton=半箱.
Example: ctx=["Mna A60 LED?"] item="Ngp" → "A60 LED 球泡多少钱？"

Strict JSON per schema.`;

// === EXPERT 长 prompt（~290 tokens；可通过 mode:"expert" 或 env 回退）===
// 已与 SLIM 对齐：只翻译，不分类。Expert 比 SLIM 多保留几条上下文消解的规范例子。
const BATCH_TRANSLATE_INSTRUCTIONS_EXPERT = `You are a WhatsApp translator for GWELL, a Chinese lighting factory with office at Kariakoo (Dar es Salaam) and factory at Kigamboni. Customers are East-African buyers writing Swahili / English / Mixed, with typos, abbreviations and short messages.

== INPUT FORMAT ==
Input MAY start with "== CONVERSATION CONTEXT ==": customer's recent prior messages, oldest → newest. REFERENCE ONLY — do NOT translate them. Use them to resolve abbreviations & pointing words in the items.

== TASK PER ITEM ==
Output translation_cn — Simplified Chinese translation.
- Already Chinese / pure URL / pure emoji → "" (empty).
- Acknowledgment ("Ok","OK","Okay","Sawa","Ndio","Yes","Sawa sawa") → "好的". NEVER "怎么样".
- Greeting ("Hi","Hello","Mambo","Habari","Vipi mzee") → "你好".
- Thanks ("Asante","Asante sana") → "谢谢" / "非常感谢".
- Short cryptic ("Vp","Hii","Ngp","30W","Bei") → MUST resolve via CONTEXT and produce a COMPLETE Chinese sentence including the topic. NEVER output 2-char literals like "价"/"怎样"/"多少".
- If context is empty AND item is a genuine poke ("Vp" but NOT "Ok"), translate to "怎么样？/在吗？".

== CONTEXT-RESOLVED EXAMPLES ==
ctx=["Mna A60 LED bulb?"]  item="Ngp"  → "A60 LED 球泡多少钱？"
ctx=["Mna taa za solar?"]  item="Bei"  → "太阳能灯多少钱？"
ctx=["nahii","30W"]        item="Vp"   → "30W 这款怎么样？有货吗？"
ctx=[]                     item="Vp"   → "怎么样？/在吗？"
ctx=anything               item="Ok"   → "好的"
item="Nusu caton (20pcs) mnauza?" → "半箱（20个）卖吗？"

== GWELL CONTEXT (model may not know) ==
Kariakoo=达市批发区, Kigamboni=GWELL 工厂区, ngp=ngapi, vp=vipi, nahii=na hii=这个呢
caton/cartoon=carton 拼写错误, carton/box/ctn/katoni=箱, nusu carton=半箱（不是"一半的纸箱"）

Respond strictly with the provided JSON schema.`;

// === 中→客户语言 schema ===
// 移除 detectionReason 字段：之前每次响应都会让模型写一段"为什么判定这个语言"的解释，
// 这部分纯属内部诊断信息但增加 ~30-60 output tokens，且会让模型多做无用推理。
const TRANSLATE_SCHEMA = {
  name: "translation_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      detectedLanguage: { type: "string" },
      detectedLanguageConfidence: { type: "string", enum: ["high", "medium", "low"] },
      translation: { type: "string" }
    },
    required: ["detectedLanguage", "detectedLanguageConfidence", "translation"],
    additionalProperties: false
  }
};

// === SLIM 默认 outbound prompt（~280 tokens）===
// 包含 4 个硬规则：身份、保留原样字段、零汉字输出、单语输出 + 词典 advisory。
// 优化痕迹：先前为修 bug 写了 ~684 token 的长版，实测过肿（占整次 input ~50%），
// 现已浓缩到核心约束，占用降低 ~58%。
function buildOutboundInstructionsSlim({ targetLanguage }) {
  // 2026-06 设计：前端做检测，传 target；后端 prompt 极简、单一职责"把中文翻成 X 语言"。
  //
  // 历史教训（被这套 prompt 逐步替代）：
  //   1) 早期 prompt 让 LLM 自己 detect + translate，结果模型经常被 customer messages
  //      带偏，扮演销售员"答客户问"而不是翻译 sourceText（实测 src="您好，烤箱已发货"
  //      被翻成 "Mizigo iko kwenye ofisi yetu ya Kariakoo" —— 直接把 system prompt
  //      里的 "Office: Kariakoo" 抠出来编了个完全不相干的回复）。
  //   2) 给了角色身份（"WhatsApp translator FOR GWELL — wholesaler in Dar es Salaam"）
  //      模型就把自己当销售员；改成"strict translator"也只缓解不根除。
  // 根治：前端确定 target，后端 prompt 不提及客户、不提及业务、不提及 GWELL 这家公司，
  //      只剩"翻成 X 语言"这一件事。客户消息根本不进 LLM input。
  return `You are a translator. Translate the Chinese text below into ${targetLanguage}. Output ONLY the translation — no quotes, no prefix, no greeting, no sales pitch, no commentary, no markdown.

Rules:
- Stay 1:1 with the source. Same meaning, same details. Do not add information not in the Chinese; do not drop information either.
- 箱 → ctn / carton / katoni (depending on target). Never drop the count (e.g. "3 箱" must keep the 3).
- Preserve numbers, units (W/V/lm/USD/TZS/mm/kg/%), product codes (A60/T8/E27/GL-xxxx), URLs, phone numbers, emojis verbatim.
- Translate every Chinese word — 老板/箱/批发价/现货/库存/报价单/订单/货物 etc. Zero Chinese characters in output.
- Single language only. Do not mix English greetings into a Swahili translation, or Swahili words into an English translation.
- Tone: friendly WhatsApp business style, like a real export salesperson texting a buyer.

Respond as strict JSON: { "detectedLanguage": "${targetLanguage}", "detectedLanguageConfidence": "high", "translation": "..." }.`;
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
      ? `The target language is FORCED to be "${overrideLanguage}". Use this as detectedLanguage with confidence "high".`
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

function buildOutboundInput({ customerMessages, sourceText, includeCustomerMessages = false }) {
  const clamped = clampHistory(customerMessages, OUTBOUND_HISTORY_MAX_ITEMS, OUTBOUND_HISTORY_MAX_CHARS);
  // Glossary 仍基于 source + customer 文本搜词条（提高召回），但下面只把 sourceText
  // 喂给模型，避免 customer messages 让 LLM 角色扮演。
  const combined = [
    sourceText,
    ...clamped.map((m) => (typeof m === "string" ? m : String(m.text || "")))
  ].filter(Boolean).join("\n");
  const glossaryBlock = buildGlossaryBlock(findGlossaryMatches(combined), "cn-to-foreign");

  const lines = [];
  if (glossaryBlock) lines.push(glossaryBlock);
  if (includeCustomerMessages && clamped.length > 0) {
    lines.push(`## Customer recent messages (for language detection only)`);
    clamped.forEach((m, i) => {
      const t = m.time ? ` [${m.time}]` : "";
      lines.push(`${i + 1}.${t} ${m.text}`);
    });
    lines.push("");
  }
  lines.push("## Chinese reply to translate");
  lines.push(sourceText);
  return lines.join("\n");
}

// 注：语言检测由前端（Chrome 扩展 content.js）负责。
// 前端结合客户最近 3 条消息 + 电话号码前缀（+255 → Swahili / +243 → French /
// +260 → English / 其他默认 English），把最终语言放在 overrideLanguage 字段
// 传给 /api/translate。后端只做"翻译成 X 语言"，不再做检测。
//
// 兜底：若前端未传 overrideLanguage，路由会用 contextHint.phoneLangHint 兜底，
// 仍然不让 LLM 看见客户消息（避免 LLM 角色扮演销售员答客户问题）。

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
    hasGeminiKey: !!GEMINI_API_KEY,
    primaryProvider: PRIMARY_PROVIDER,
    geminiModel: GEMINI_DEFAULT_MODEL,
    authEnabled: AUTH_ENABLED,
    allowedCount: AUTH_ENABLED ? ALLOWED_USERS.size : 0,
    yourUser: user || null,
    authorized,
    defaultTranslateMode: DEFAULT_TRANSLATE_MODE,
    allowPremiumModels: ALLOW_PREMIUM_MODELS,
    fallbackModel: FALLBACK_MODEL,
    glossaryEntries: GLOSSARY.length,
    buildVersion: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
    promptVersion: "translate-only-v3"
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
      model: requestedModel = null,
      mode: reqMode
    } = req.body || {};

    const src = String(sourceText || "").trim();
    if (!src) return res.status(400).json({ ok: false, error: "EMPTY_SOURCE" });

    // === Target language 解析（前端做检测，后端只翻译） ===
    // 优先级：overrideLanguage（前端检测结果）> phoneLangHint > 默认 English
    // 把 phoneHint 兜底白名单到 Swahili / English / French；其它值视为 None。
    const phoneHint = contextHint && contextHint.phoneLangHint
      ? String(contextHint.phoneLangHint).trim()
      : "";
    const validLangs = new Set(["Swahili", "English", "French"]);
    let targetLanguage;
    let targetSource; // 仅用于日志：override / phoneHint / default
    if (overrideLanguage && validLangs.has(String(overrideLanguage))) {
      targetLanguage = String(overrideLanguage);
      targetSource = "override";
    } else if (phoneHint && validLangs.has(phoneHint)) {
      targetLanguage = phoneHint;
      targetSource = "phoneHint";
    } else {
      targetLanguage = "English";
      targetSource = "default";
    }

    // 不传 model = 走 PRIMARY_PROVIDER 默认（Gemini）；
    // 传 "gpt-..." 强制 OpenAI；传 "gemini-..." 强制 Gemini。
    const { provider: chosenProvider, model } = resolveProviderModel(requestedModel, "/api/translate");
    const modelDowngraded = isOpenAIModel(requestedModel) && model !== requestedModel;

    const mode = (String(reqMode || DEFAULT_TRANSLATE_MODE).toLowerCase() === "expert") ? "expert" : "slim";
    const instructions = mode === "expert"
      ? buildOutboundInstructionsExpert({ overrideLanguage: targetLanguage, contextHint })
      : buildOutboundInstructionsSlim({ targetLanguage });
    // KEY：customerMessages 不再喂给 LLM。LLM 只看 sourceText + glossary。
    // 这样 LLM 没机会"代你回客户"。
    const input = buildOutboundInput({
      customerMessages,
      sourceText: src,
      includeCustomerMessages: false
    });

    // outbound 默认走 OpenAI（gpt-4o-mini）；详见 resolveProviderModel 注释。
    // OpenAI 没有 thinking 概念；maxOutputTokens=1200 覆盖长翻译。
    // 若 OpenAI 故障回退 Gemini，callTranslateAPI 不传 thinkingBudget → Gemini
    // 用默认 ~1024 token 思考预算，1200 也够用。
    const {
      text,
      usage,
      provider: usedProvider,
      modelUsed,
      providerFallback,
      primaryError
    } = await callTranslateAPI({
      provider: chosenProvider,
      model,
      instructions,
      input,
      jsonSchema: TRANSLATE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 1200
    });

    logUsage({
      route: "/api/translate",
      mode,
      inputChars: instructions.length + input.length,
      usage,
      model: modelUsed,
      provider: usedProvider,
      providerFallback,
      withProducts: false,
      withHistory: false,  // 客户消息不再喂给 LLM
      targetLanguage,
      targetSource
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // JSON 解析失败（通常是 max_output_tokens 截断）。绝对不能把"截断 JSON 串"
      // 当 translation 返回——前端会原样塞进 WhatsApp 输入框。
      // 改为：用正则抢救 translation 字段；抢救不到就返回 ok:false 让前端走错误提示。
      console.warn(
        `[/api/translate] non-JSON output: provider=${usedProvider} model=${modelUsed} ` +
        `outputLen=${(text || "").length} usage=${JSON.stringify(usage || {})} ` +
        `preview=${JSON.stringify((text || "").slice(0, 400))}`
      );
      const recoveredTranslation = extractJsonStringField(text, "translation");
      if (!recoveredTranslation) {
        return res.status(502).json({
          ok: false,
          error: "BAD_JSON_FROM_MODEL: translation truncated or malformed (likely max_output_tokens hit). 请重试一次。",
          provider: usedProvider,
          model: modelUsed,
          usage,
          providerFallback,
          primaryError: providerFallback ? primaryError : undefined
        });
      }
      parsed = {
        detectedLanguage: targetLanguage,
        detectedLanguageConfidence: "low",
        translation: recoveredTranslation
      };
    }

    // 防御：万一模型没按 schema 写 detectedLanguage，强制 override 成前端决定的 target。
    if (!parsed.detectedLanguage) parsed.detectedLanguage = targetLanguage;
    if (!parsed.detectedLanguageConfidence) parsed.detectedLanguageConfidence = "high";

    // 临时调试（2026-06）：等翻译质量验证完毕后移除。
    const debugEcho = req.query?.debug === "1" || req.body?.__debug === true ? {
      _debug: {
        promptVersion: "translate-only-v3",
        targetLanguage,
        targetSource,
        instructionsLen: instructions.length,
        inputLen: input.length,
        instructions,
        input,
        rawOutput: text
      }
    } : {};

    res.json({
      ok: true,
      ...parsed,
      targetLanguage,
      targetSource,
      usage,
      model: modelUsed,
      provider: usedProvider,
      providerFallback,
      primaryError: providerFallback ? primaryError : undefined,
      mode,
      requestedModel,
      modelDowngraded,
      ...debugEcho
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

// === 主路由 2：批量来信 → 中文（仅翻译；意图分类已移除） ===
// upgradeModel 字段保留向后兼容（前端可能仍在传），但不再触发升级。
app.post("/api/batch-translate-incoming", requireUser, async (req, res) => {
  try {
    const {
      items: rawItems,
      recentContext: rawCtx = [],
      model: requestedModel = null,
      upgradeModel: requestedUpgradeModel = null,
      mode: reqMode
    } = req.body || {};

    const items = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
    if (items.length === 0) return res.json({ ok: true, translations: [] });

    // 不传 model = 走 PRIMARY_PROVIDER 默认（Gemini）；
    // 传 "gpt-..." 强制 OpenAI；传 "gemini-..." 强制 Gemini。
    const { provider: chosenProvider, model } = resolveProviderModel(requestedModel, "/api/batch-translate-incoming");
    const modelDowngraded = isOpenAIModel(requestedModel) && model !== requestedModel;

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

    // 输出 token 上限：每条 ~220 token，最少 350，最多 2000
    // （之前 80/200 在单条超 100 字符的长 Swahili 消息下会被 JSON 结构挤爆 → 截断 →
    //  "Unexpected end of JSON input"。220 足够覆盖 ~120 中文字 + JSON 包裹。）
    const perItemOutput = 220;
    const maxOutputTokens = Math.min(Math.max(items.length * perItemOutput, 350), 2000);

    async function callBatchOnce({ provider: pv, model: m, items: subItems }) {
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
      const {
        text,
        usage,
        provider: usedProvider,
        modelUsed,
        providerFallback,
        primaryError
      } = await callTranslateAPI({
        provider: pv,
        model: m,
        instructions: batchInstructions,
        input: subInput,
        jsonSchema: BATCH_TRANSLATE_SCHEMA,
        temperature: 0.2,
        timeoutMs: 60000,
        maxOutputTokens: Math.min(Math.max(subItems.length * perItemOutput, 350), 2000),
        // BATCH 是扁平任务"挨个翻译成中文"，关掉 thinking 提速降本
        thinkingBudget: 0
      });
      logUsage({
        route: "/api/batch-translate-incoming",
        mode,
        inputChars: batchInstructions.length + subInput.length,
        usage,
        model: modelUsed,
        provider: usedProvider,
        providerFallback,
        withProducts: false,
        withHistory: recentContext.length > 0
      });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        // 关键诊断信息：把模型的原始返回打到 Railway log，方便下次定位
        // （限 800 char 防止日志爆炸；通常截断只在末尾几十字节）
        const preview = (text || "").slice(0, 800);
        console.error(
          `[batch] BAD_JSON_FROM_MODEL: provider=${usedProvider} model=${modelUsed} ` +
          `outputLen=${(text || "").length} ` +
          `maxOutputTokens=${Math.min(Math.max(subItems.length * perItemOutput, 350), 2000)} ` +
          `usage=${JSON.stringify(usage || {})}`
        );
        console.error(`[batch] BAD_JSON_FROM_MODEL preview: ${JSON.stringify(preview)}`);
        throw new Error("BAD_JSON_FROM_MODEL: " + (err?.message || String(err)));
      }
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        usage,
        provider: usedProvider,
        modelUsed,
        providerFallback,
        primaryError
      };
    }

    const {
      items: rawTranslations,
      usage,
      provider: usedProvider,
      modelUsed,
      providerFallback,
      primaryError
    } = await callBatchOnce({ provider: chosenProvider, model, items });

    // 移除 confidence-based 自动升级（用户决定意图自己分析，模型不再产出 confidence 信号）。
    // 为兼容现有 Chrome 插件可能读取这些字段，路由层默认补齐 intent/secondary_intents/confidence。
    const translations = rawTranslations.map((t) => ({
      id: t.id,
      translation_cn: t.translation_cn,
      intent: "other",
      secondary_intents: [],
      confidence: "medium"
    }));

    res.json({
      ok: true,
      translations,
      usage,
      upgradeUsage: null,
      upgradedIds: [],
      model: modelUsed,
      upgradeModel: null,
      provider: usedProvider,
      providerFallback,
      primaryError: providerFallback ? primaryError : undefined,
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
