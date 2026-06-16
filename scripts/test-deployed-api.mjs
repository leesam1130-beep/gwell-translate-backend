// 部署后 API 联调测试
// 用法：
//   node scripts/test-deployed-api.mjs <BACKEND_URL>
// 例：
//   node scripts/test-deployed-api.mjs https://tanzania-lighting-production.up.railway.app
//
// 跑 4 项测试：
//   1) /api/health                          — 验证 key/provider 配置正确
//   2) /api/translate                       — 默认 provider（Gemini）翻译
//   3) /api/translate (model=gpt-4o-mini)   — 强制 OpenAI 通路
//   4) /api/batch-translate-incoming        — 批量 + 验证 Ok / nusu caton 修正

const URL_BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!URL_BASE) {
  console.error("❌ 用法: node scripts/test-deployed-api.mjs <BACKEND_URL>");
  console.error('   例: node scripts/test-deployed-api.mjs "https://tanzania-lighting-production.up.railway.app"');
  process.exit(1);
}
console.log(`Target: ${URL_BASE}\n`);

const results = [];

async function call(path, init) {
  const url = `${URL_BASE}${path}`;
  const t0 = Date.now();
  const res = await fetch(url, init);
  const ms = Date.now() - t0;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, raw: text, ms };
}

const pass = (name, detail) => { results.push({ name, ok: true, detail }); console.log(`✓ ${name}  ${detail}`); };
const fail = (name, detail) => { results.push({ name, ok: false, detail }); console.log(`✗ ${name}  ${detail}`); };

// ---------- 1) /api/health ----------
{
  console.log("\n--- 1) /api/health ---");
  const r = await call("/api/health");
  if (!r.ok) {
    fail("health", `HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
  } else {
    const j = r.json || {};
    console.log(JSON.stringify(j, null, 2));
    if (j.hasGeminiKey && j.hasKey) pass("两个 key 都已配", `primary=${j.primaryProvider} gemini=${j.geminiModel}`);
    else if (j.hasGeminiKey || j.hasKey) fail("仅一个 provider 有 key", `hasKey(OpenAI)=${j.hasKey} hasGeminiKey=${j.hasGeminiKey} → 没有自动容灾`);
    else fail("两个 key 都缺", "请去 Railway Variables 配置 OPENAI_API_KEY 和 GEMINI_API_KEY");
    if (j.primaryProvider) pass("primaryProvider 字段返回", j.primaryProvider);
  }
}

// ---------- 2) /api/translate 默认（应该走 Gemini）----------
{
  console.log("\n--- 2) /api/translate (default → Gemini) ---");
  const body = {
    sourceText: "你好，您的订单已经准备好了，今天发货",
    customerMessages: [{ text: "Habari, mzigo wangu uko wapi?", time: "10:30" }]
  };
  const r = await call("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    fail("/api/translate default", `HTTP ${r.status} (${r.ms}ms): ${(r.raw || "").slice(0, 300)}`);
  } else {
    const j = r.json || {};
    console.log(`  provider     : ${j.provider}`);
    console.log(`  model        : ${j.model}`);
    console.log(`  fallback     : ${j.providerFallback}${j.providerFallback ? `  primaryError=${j.primaryError}` : ""}`);
    console.log(`  detected lang: ${j.detectedLanguage}  conf=${j.detectedLanguageConfidence}`);
    console.log(`  translation  : ${j.translation}`);
    console.log(`  usage        : ${JSON.stringify(j.usage)}`);
    console.log(`  latency      : ${r.ms}ms`);
    if (j.translation && j.translation.length > 5) pass("default translate", `${j.provider}/${j.model}`);
    else fail("default translate", "返回 translation 异常");
  }
}

// ---------- 3) /api/translate 强制 OpenAI ----------
{
  console.log("\n--- 3) /api/translate (force model=gpt-4o-mini → OpenAI) ---");
  const body = {
    sourceText: "你好，您的订单已经准备好了",
    customerMessages: [],
    model: "gpt-4o-mini"
  };
  const r = await call("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    fail("/api/translate force-openai", `HTTP ${r.status}: ${(r.raw || "").slice(0, 300)}`);
  } else {
    const j = r.json || {};
    console.log(`  provider     : ${j.provider}  (期望 openai)`);
    console.log(`  model        : ${j.model}`);
    console.log(`  fallback     : ${j.providerFallback}`);
    console.log(`  translation  : ${j.translation}`);
    console.log(`  latency      : ${r.ms}ms`);
    if (j.provider === "openai") pass("force-openai 路由正确", j.model);
    else if (j.provider === "gemini" && j.providerFallback) pass("OpenAI 失败但 Gemini 容灾成功", "primaryError 已记录");
    else fail("force-openai 但走了别的", `provider=${j.provider}`);
  }
}

// ---------- 4) /api/batch-translate-incoming ----------
{
  console.log("\n--- 4) /api/batch-translate-incoming ---");
  const body = {
    items: [
      { id: "m1", text: "Bei ya solar light ngapi?" },
      { id: "m2", text: "Ok asante" },
      { id: "m3", text: "Nusu caton (20pcs) mnauza?" }
    ],
    recentContext: ["Mna taa za solar?"]
  };
  const r = await call("/api/batch-translate-incoming", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    fail("/api/batch-translate-incoming", `HTTP ${r.status}: ${(r.raw || "").slice(0, 300)}`);
  } else {
    const j = r.json || {};
    console.log(`  provider     : ${j.provider}`);
    console.log(`  model        : ${j.model}`);
    console.log(`  fallback     : ${j.providerFallback}${j.providerFallback ? `  primaryError=${j.primaryError}` : ""}`);
    console.log(`  usage        : ${JSON.stringify(j.usage)}`);
    console.log(`  latency      : ${r.ms}ms`);
    console.log(`  translations :`);
    for (const t of (j.translations || [])) {
      console.log(`    [${t.id}] ${t.translation_cn}`);
    }

    const m1 = j.translations?.find((x) => x.id === "m1")?.translation_cn || "";
    const m2 = j.translations?.find((x) => x.id === "m2")?.translation_cn || "";
    const m3 = j.translations?.find((x) => x.id === "m3")?.translation_cn || "";
    if (m1.includes("太阳能") || m1.includes("多少") || m1.match(/价[格钱]?/)) pass("m1 (Bei ya solar)", m1);
    else fail("m1 (Bei ya solar)", `期望含太阳能/价格 → ${m1}`);
    if (m2.includes("好的") || m2.includes("谢谢")) pass("m2 (Ok asante)", m2);
    else if (/怎么样|在吗/.test(m2)) fail("m2 (Ok asante) 仍被当 poke", `应该 = "好的，谢谢" → ${m2}`);
    else fail("m2 (Ok asante)", `期望含 好的/谢谢 → ${m2}`);
    if (m3.includes("半箱")) pass("m3 (Nusu caton)", m3);
    else if (m3.includes("纸箱")) fail("m3 (Nusu caton)", `仍出现"纸箱"，应是"半箱" → ${m3}`);
    else fail("m3 (Nusu caton)", `期望含"半箱" → ${m3}`);
  }
}

// ---------- Summary ----------
console.log("\n========================================");
const okCount = results.filter((r) => r.ok).length;
const koCount = results.length - okCount;
console.log(`Summary: ${okCount} pass, ${koCount} fail (${results.length} checks)`);
if (koCount === 0) {
  console.log("✓ 后端联调全部通过！");
} else {
  console.log("✗ 有失败项：");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
