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
// OpenAI Responses API caller (1:1 与旧 background.js 行为一致)
// ============================================================
async function callOpenAIResponses({
  model,
  instructions,
  input,
  jsonSchema,
  temperature = 0.3,
  timeoutMs = 60000
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

function buildOutboundInstructions({ overrideLanguage, contextHint }) {
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
  const lines = [];
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasKey: !!OPENAI_API_KEY });
});

// === 主路由 1：outbound 中→客户语言 ===
app.post("/api/translate", async (req, res) => {
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

    const instructions = buildOutboundInstructions({ overrideLanguage, contextHint });
    const input = buildOutboundInput({ customerMessages, sourceText: src });

    const { text, usage } = await callOpenAIResponses({
      model,
      instructions,
      input,
      jsonSchema: TRANSLATE_SCHEMA,
      temperature: 0.3
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
app.post("/api/batch-translate-incoming", async (req, res) => {
  try {
    const {
      items: rawItems,
      recentContext: rawCtx = [],
      model = "gpt-4o-mini",
      upgradeModel = null
    } = req.body || {};

    const items = Array.isArray(rawItems) ? rawItems.filter(Boolean) : [];
    if (items.length === 0) return res.json({ ok: true, translations: [] });

    const recentContext = (Array.isArray(rawCtx) ? rawCtx : [])
      .map((s) => String(s || "").replace(/\r?\n/g, " ").trim())
      .filter(Boolean)
      .slice(-8);

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

    async function callBatchOnce({ model: m, items: subItems }) {
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
        timeoutMs: 60000
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
      upgradeModel: canUpgrade ? upgradeModel : null
    });
  } catch (err) {
    console.error("[/api/batch-translate-incoming]", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// === Legacy 简单翻译，保留向后兼容 ===
app.post("/translate", async (req, res) => {
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
