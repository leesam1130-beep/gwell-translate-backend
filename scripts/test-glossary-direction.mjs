// 验证修复后两个方向的词典块格式正确
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
      if (/[\u4e00-\u9fff]/.test(p)) return { type: "cjk", needle: p };
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { type: "re", re: new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i") };
    })
    .filter(Boolean);
}

function findMatches(text) {
  const lower = String(text).toLowerCase();
  const out = [];
  for (const e of GLOSSARY) {
    for (const c of e._compiled) {
      if (c.type === "cjk" ? lower.includes(c.needle) : c.re.test(lower)) { out.push(e); break; }
    }
  }
  return out;
}

function buildGlossaryBlock(matches, direction) {
  if (!matches || matches.length === 0) return "";
  const splitSides = (m) => {
    const all = m.patterns || [];
    return {
      cn: all.filter((p) => /[\u4e00-\u9fff]/.test(p)),
      fn: all.filter((p) => !/[\u4e00-\u9fff]/.test(p))
    };
  };
  if (direction === "cn-to-foreign") {
    const lines = matches.map((m) => {
      const { cn, fn } = splitSides(m);
      const left = (cn[0] || m.zh).trim();
      const right = fn.length ? fn.join(" / ") : (m.en || m.zh);
      const note = m.note ? ` (${m.note})` : "";
      return `- ${left} → ${right}${note}`;
    });
    return `## Glossary (Chinese → target language)\nWhen these Chinese terms appear in the source, translate them as shown. Do NOT leave them in Chinese.\n${lines.join("\n")}\n`;
  }
  const lines = matches.map((m) => {
    const { fn } = splitSides(m);
    const left = fn.length ? fn.join(" / ") : (m.en || m.zh);
    const right = m.zh;
    const note = m.note ? ` (${m.note})` : "";
    return `- ${left} → ${right}${note}`;
  });
  return `## Glossary (foreign → Chinese)\nWhen these foreign-language terms appear in the source, translate them exactly as shown.\n${lines.join("\n")}\n`;
}

console.log("=".repeat(72));
console.log("CASE 1: 用户实际遇到的问题样本（中→Swahili）");
console.log("=".repeat(72));
const cn1 = "这是我们的价格表，包含每箱数量和批发价格";
const m1 = findMatches(cn1);
console.log(`\nINPUT: ${cn1}`);
console.log(`MATCHES: ${m1.length}\n`);
console.log(buildGlossaryBlock(m1, "cn-to-foreign"));

console.log("=".repeat(72));
console.log("CASE 2: 桑给巴尔送货（中→Swahili）");
console.log("=".repeat(72));
const cn2 = "我们送货到桑给巴尔，运费免费";
const m2 = findMatches(cn2);
console.log(`\nINPUT: ${cn2}`);
console.log(`MATCHES: ${m2.length}\n`);
console.log(buildGlossaryBlock(m2, "cn-to-foreign"));

console.log("=".repeat(72));
console.log("CASE 3: Swahili→中（来信批量翻译）");
console.log("=".repeat(72));
const sw3 = "Mna unguja? Naomba bei poa kwa LED 30W";
const m3 = findMatches(sw3);
console.log(`\nINPUT: ${sw3}`);
console.log(`MATCHES: ${m3.length}\n`);
console.log(buildGlossaryBlock(m3, "foreign-to-cn"));
