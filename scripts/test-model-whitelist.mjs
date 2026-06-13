// 验证模型白名单是否生效：本地发起 7 种不同 model 请求，观察 modelDowngraded 字段

async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  return r.json();
}

const tests = [
  { name: "gpt-4o (premium, 应被降级)",            body: { sourceText: "你好", model: "gpt-4o" } },
  { name: "gpt-4o-2024-08-06 (premium, 应被降级)", body: { sourceText: "你好", model: "gpt-4o-2024-08-06" } },
  { name: "gpt-4.1 (premium, 应被降级)",           body: { sourceText: "你好", model: "gpt-4.1" } },
  { name: "o1-mini (premium, 应被降级)",           body: { sourceText: "你好", model: "o1-mini" } },
  { name: "gpt-4o-mini (allowed, 不降级)",          body: { sourceText: "你好", model: "gpt-4o-mini" } },
  { name: "gpt-4.1-mini (allowed, 不降级)",         body: { sourceText: "你好", model: "gpt-4.1-mini" } },
  { name: "unknown-xyz (未知, 应降级)",             body: { sourceText: "你好", model: "unknown-xyz" } }
];

console.log("注：本地 .env 是占位 key，OpenAI 调用会 401；只看 requestedModel/model 字段是否正确执行白名单\n");

for (const t of tests) {
  const r = await post("http://localhost:3000/api/translate", t.body);
  const reqM = r.requestedModel ?? "?";
  const useM = r.model ?? "?";
  const dg = r.modelDowngraded === true;
  const flag = dg ? "🔻 DOWNGRADED" : "✓ kept";
  console.log(`[${t.name}]`);
  console.log(`   requestedModel = ${reqM}`);
  console.log(`   actual model   = ${useM}   ${flag}`);
  if (r.error) console.log(`   (note) error   = ${String(r.error).slice(0, 80)}...`);
  console.log("");
}
