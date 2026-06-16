// 离线测试：schema 转换 + provider 路由判定逻辑
// 不调真实 API；只验证我们的内部判断 + schema 转换正确。

const STRIP = new Set(["additionalProperties", "$schema", "strict", "name"]);
function convertSchemaForGemini(jsonSchema) {
  if (!jsonSchema) return null;
  const root = jsonSchema.schema || jsonSchema;
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

function isGeminiModel(m) { return /^gemini[-_]/i.test(String(m || "")); }
function isOpenAIModel(m) {
  const s = String(m || "").toLowerCase();
  return s.startsWith("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("chatgpt");
}

const tests = [];
const assert = (name, cond, detail = "") => {
  tests.push({ name, ok: !!cond, detail });
};

// === Test 1：模型识别 ===
assert("gemini-2.0-flash → Gemini", isGeminiModel("gemini-2.0-flash") && !isOpenAIModel("gemini-2.0-flash"));
assert("gemini-1.5-flash-8b → Gemini", isGeminiModel("gemini-1.5-flash-8b"));
assert("gpt-4o-mini → OpenAI", isOpenAIModel("gpt-4o-mini") && !isGeminiModel("gpt-4o-mini"));
assert("o1-mini → OpenAI", isOpenAIModel("o1-mini"));
assert("chatgpt-4o-latest → OpenAI", isOpenAIModel("chatgpt-4o-latest"));
assert("undefined → 都不是", !isGeminiModel(undefined) && !isOpenAIModel(undefined));
assert("空字符串 → 都不是", !isGeminiModel("") && !isOpenAIModel(""));
assert("乱填 → 都不是", !isGeminiModel("foo-bar") && !isOpenAIModel("foo-bar"));

// === Test 2：schema 转换（用 server.js 实际 schema）===
const TRANSLATE_SCHEMA = {
  name: "translation_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      detectedLanguage: { type: "string", enum: ["English", "Swahili", "French", "Other"] },
      detectedLanguageConfidence: { type: "string", enum: ["high", "medium", "low"] },
      translation: { type: "string" }
    },
    required: ["detectedLanguage", "detectedLanguageConfidence", "translation"],
    additionalProperties: false
  }
};

const converted = convertSchemaForGemini(TRANSLATE_SCHEMA);
assert("converted.type === object", converted.type === "object");
assert("strip additionalProperties", !("additionalProperties" in converted));
assert("strip strict", !("strict" in converted));
assert("strip name", !("name" in converted));
assert("保留 properties", typeof converted.properties === "object");
assert("保留 required", Array.isArray(converted.required) && converted.required.length === 3);
assert("保留 enum",
  Array.isArray(converted.properties?.detectedLanguage?.enum) &&
  converted.properties.detectedLanguage.enum.length === 4);

// === Test 3：嵌套 schema（batch 那种 array of object）===
const BATCH_SCHEMA = {
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

const c2 = convertSchemaForGemini(BATCH_SCHEMA);
assert("batch: top-level no additionalProperties", !("additionalProperties" in c2));
assert("batch: items.items 也剥干净",
  c2.properties?.items?.items &&
  !("additionalProperties" in c2.properties.items.items));
assert("batch: items.items.properties 完整",
  c2.properties?.items?.items?.properties?.id?.type === "string");

// === 输出 ===
const passed = tests.filter((t) => t.ok).length;
const failed = tests.filter((t) => !t.ok);

console.log(`\n=== Provider routing & schema conversion tests ===`);
console.log(`PASSED: ${passed}/${tests.length}`);
if (failed.length) {
  console.log(`\nFAILED:`);
  for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
  process.exit(1);
} else {
  console.log(`✓ All checks passed.`);
}

// 也打印一下转换后的 schema，肉眼确认下
console.log(`\nConverted TRANSLATE_SCHEMA:`);
console.log(JSON.stringify(converted, null, 2));
console.log(`\nConverted BATCH_SCHEMA:`);
console.log(JSON.stringify(c2, null, 2));
