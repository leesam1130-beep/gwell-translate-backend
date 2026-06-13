// 本地验证 local-glossary.json 是否在常见输入下命中正确条目
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GLOSSARY = JSON.parse(
  readFileSync(join(__dirname, "..", "local-glossary.json"), "utf8")
);

function findGlossaryMatches(text) {
  if (!GLOSSARY.length || !text) return [];
  const lower = String(text).toLowerCase();
  const matches = [];
  const seen = new Set();
  for (const entry of GLOSSARY) {
    if (seen.has(entry)) continue;
    const pats = Array.isArray(entry.patterns) ? entry.patterns : [];
    for (const pat of pats) {
      const p = String(pat || "").toLowerCase();
      if (!p) continue;
      let hit = false;
      if (/[\u4e00-\u9fff]/.test(p)) {
        hit = lower.includes(p);
      } else {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        hit = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lower);
      }
      if (hit) {
        matches.push(entry);
        seen.add(entry);
        break;
      }
    }
  }
  return matches;
}

function buildGlossaryBlock(matches) {
  if (!matches || matches.length === 0) return "";
  const lines = matches.map((m) => {
    const en = m.en || (Array.isArray(m.patterns) ? m.patterns[0] : "");
    const note = m.note ? ` — ${m.note}` : "";
    return `- ${en} ↔ ${m.zh}${note}`;
  });
  return `## Local-knowledge terms found in this conversation (use these mappings exactly, both directions)\n${lines.join("\n")}\n\n`;
}

const cases = [
  "Mna unguja? Naomba bei.",
  "我们送货到桑给巴尔，价格 USD 200/CTN",
  "Naomba uniletee Kariakoo kesho asubuhi",
  "Tunatuma Pemba na Mwanza pia",
  "Boss, bei poa kwa LED 30W?",
  "Hello good price please",
  "Send me by M-Pesa",
  "I need 50 CTN to Kibamba"
];

console.log(`Loaded ${GLOSSARY.length} glossary entries\n`);
console.log("=".repeat(72));

for (const c of cases) {
  const matches = findGlossaryMatches(c);
  const block = buildGlossaryBlock(matches);
  console.log(`\nINPUT : ${c}`);
  console.log(`MATCH : ${matches.length} entries`);
  if (block) {
    console.log(`BLOCK :\n${block.split("\n").map((l) => "        " + l).join("\n")}`);
  } else {
    console.log("BLOCK : (empty — 0 extra tokens)");
  }
  console.log("-".repeat(72));
}
