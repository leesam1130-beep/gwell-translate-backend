// 在真实 local-glossary.json 上跑性能测试
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GLOSSARY = JSON.parse(
  readFileSync(join(__dirname, "..", "local-glossary.json"), "utf8")
);

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

function findMatches(text) {
  const lower = String(text).toLowerCase();
  const matches = [];
  for (const entry of GLOSSARY) {
    for (const c of entry._compiled || []) {
      if (c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower)) {
        matches.push(entry);
        break;
      }
    }
  }
  return matches;
}

const SAMPLES = [
  "Mna unguja? Naomba bei nzuri kwa LED 30W",
  "我们送货到桑给巴尔，价格 USD 200/CTN，请确认",
  "Naomba uniletee Kariakoo kesho asubuhi, malipo M-Pesa",
  "Tunatuma Pemba na Mwanza pia, lakini bei tofauti",
  "Boss, bei poa kwa LED 30W ya CTN moja?",
  "Hello good price please for 100 cartons to Nairobi",
  "我需要 50 箱 30W LED 灯泡运到 Lubumbashi",
  "Habari yako, naomba quotation ya 200 cartons kwenda Mtwara",
  "I need 50 CTN to Kigamboni and another 30 to Bagamoyo by next week",
  "Bei nzuri ela ndogo, samahani — naweza kupata 5% discount?",
  "Sawa boss, nipo Kariakoo, niletee mzigo ofisini kesho jioni",
  "Stock ipo? Mna feni 16 inch? Bei gani kwa carton?",
  "Mzigo umefika Kigamboni jana, asante sana, nitaagiza tena",
  "Nataka box moja ya solar light na panel 50W, ina warranty?",
  "Tuma jina la mpokeaji na namba ya simu, gari linakwenda Mwanza"
];

const ITERS = 2000;

// warmup
for (let i = 0; i < 200; i++) findMatches(SAMPLES[i % SAMPLES.length]);

const samples = [];
const t0 = process.hrtime.bigint();
for (let i = 0; i < ITERS; i++) {
  const a = process.hrtime.bigint();
  findMatches(SAMPLES[i % SAMPLES.length]);
  const b = process.hrtime.bigint();
  samples.push(Number(b - a) / 1e3);
}
const t1 = process.hrtime.bigint();
const totalMs = Number(t1 - t0) / 1e6;

samples.sort((a, b) => a - b);
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const p99 = samples[Math.floor(samples.length * 0.99)];
const qps = Math.round(ITERS / (totalMs / 1000));

console.log(`词条总数 : ${GLOSSARY.length}`);
console.log(`pattern 总数 : ${GLOSSARY.reduce((n, e) => n + e._compiled.length, 0)}`);
console.log();
console.log(`扫描 ${ITERS} 次（15 个真实业务句子轮换）`);
console.log(`P50  ${p50.toFixed(1).padStart(7)} µs`);
console.log(`AVG  ${avg.toFixed(1).padStart(7)} µs`);
console.log(`P95  ${p95.toFixed(1).padStart(7)} µs`);
console.log(`P99  ${p99.toFixed(1).padStart(7)} µs`);
console.log(`QPS  ${qps.toLocaleString().padStart(7)} req/s（单线程纯扫描能力）`);
console.log();
console.log(`说明：OpenAI 调用本身 500-3000 ms，本地扫描占比 < 1%。`);
