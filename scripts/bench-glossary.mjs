// 模拟不同规模的词典，测量每次请求的扫描耗时
// 用法: node scripts/bench-glossary.mjs

function makeFakeGlossary(n) {
  const places = ["alpha","beta","gamma","delta","epsilon","zeta","eta","theta","iota","kappa","lambda","mu","nu","xi","omicron","pi","rho","sigma","tau","upsilon","phi","chi","psi","omega"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = places[i % places.length] + i.toString(36);
    out.push({
      patterns: [p, p + "x", "中" + i.toString(36)],
      zh: "测试词" + i,
      en: "test entry " + i
    });
  }
  return out;
}

function compile(glossary) {
  for (const entry of glossary) {
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
}

function findMatches(GLOSSARY, text) {
  if (!GLOSSARY.length || !text) return [];
  const lower = String(text).toLowerCase();
  const matches = [];
  for (const entry of GLOSSARY) {
    const compiled = entry._compiled || [];
    for (const c of compiled) {
      const hit = c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower);
      if (hit) { matches.push(entry); break; }
    }
  }
  return matches;
}

const SAMPLE_TEXTS = [
  "Mna unguja? Naomba bei nzuri kwa LED bulb 30W",
  "我们送货到桑给巴尔，价格 USD 200/CTN，请确认收货地址",
  "Naomba uniletee Kariakoo kesho asubuhi, malipo M-Pesa",
  "Tunatuma Pemba na Mwanza pia, lakini bei tofauti",
  "Boss, bei poa kwa LED 30W ya CTN moja?",
  "Hello good price please for 100 cartons to Nairobi",
  "我需要 50 箱 30W LED 灯泡运到 Lubumbashi，运费多少",
  "Habari yako, naomba quotation ya 200 cartons kwenda Mtwara, mzigo ufike Ijumaa",
  "I need 50 CTN to Kibamba and another 30 to Bagamoyo by next week",
  "Bei nzuri ela ndogo, samahani — naweza kupata 5% discount kwa malipo ya cash?"
];

const sizes = [30, 100, 500, 2000, 5000, 10000];
const ITERS = 1000;

console.log("规模\t加载耗时\t单次扫描平均(µs)\t单次扫描P95(µs)\t1000次QPS");
console.log("=".repeat(90));

for (const n of sizes) {
  const t0 = process.hrtime.bigint();
  const G = makeFakeGlossary(n);
  compile(G);
  const t1 = process.hrtime.bigint();
  const loadMs = Number(t1 - t0) / 1e6;

  // warm up
  for (let i = 0; i < 100; i++) findMatches(G, SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]);

  const samples = [];
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < ITERS; i++) {
    const tA = process.hrtime.bigint();
    findMatches(G, SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]);
    const tB = process.hrtime.bigint();
    samples.push(Number(tB - tA) / 1e3); // µs
  }
  const t3 = process.hrtime.bigint();
  const totalMs = Number(t3 - t2) / 1e6;

  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const qps = Math.round(ITERS / (totalMs / 1000));

  console.log(`${n.toString().padEnd(8)}${loadMs.toFixed(1).padEnd(14)}ms\t${avg.toFixed(1).padEnd(20)}\t${p95.toFixed(1).padEnd(20)}\t${qps.toLocaleString()} req/s`);
}

console.log("\n说明：单次扫描时间是后端在 OpenAI 请求前做的本地预处理；网络/模型耗时通常在 500-3000 ms。");
