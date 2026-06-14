// 把 scripts/raw-glossary.txt 里的「原词 = 中文译法 (可选 note)」格式
// 转换成 server.js 期望的 local-glossary.json 标准结构（按 zh 分组）
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RAW = readFileSync(join(__dirname, "raw-glossary.txt"), "utf8");

// 单字母 / 太短且会与英文常见词冲突的 pattern 直接跳过（避免误注入）
const BLACKLIST = new Set(["v", "w"]);

const isCJK = (s) => /[\u4e00-\u9fff]/.test(s);
const hasLatin = (s) => /[a-z0-9]/i.test(s);

function parseLine(line) {
  const idx = line.indexOf("=");
  if (idx < 0) return null;
  let key = line.substring(0, idx).trim();
  let value = line.substring(idx + 1).trim();
  if (!key || !value) return null;

  let note = "";
  // 仅匹配 value 末尾的 (中文/英文括号) 中的注释
  const noteMatch = value.match(/[（(]([^()（）]+)[）)]\s*$/);
  if (noteMatch) {
    note = noteMatch[1].trim();
    value = value.substring(0, noteMatch.index).trim();
  }
  return { key, value, note };
}

const lines = RAW.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const skipped = [];
const tentative = [];

for (const line of lines) {
  const p = parseLine(line);
  if (!p) continue;
  const { key, value, note } = p;

  const keyIsCJK = isCJK(key);
  const valueIsCJK = isCJK(value);

  let foreignPattern, zhForm;
  if (keyIsCJK && !valueIsCJK) {
    zhForm = key;
    foreignPattern = value.toLowerCase();
  } else if (!keyIsCJK && valueIsCJK) {
    foreignPattern = key.toLowerCase();
    zhForm = value;
  } else if (!keyIsCJK && !valueIsCJK) {
    foreignPattern = key.toLowerCase();
    zhForm = value;
  } else {
    zhForm = key;
    foreignPattern = String(value).toLowerCase();
  }

  if (BLACKLIST.has(foreignPattern)) {
    skipped.push({ line, reason: "blacklist (single-letter / too generic)" });
    continue;
  }
  if (foreignPattern.length === 1 && /[a-z]/i.test(foreignPattern)) {
    skipped.push({ line, reason: "single Latin letter" });
    continue;
  }

  tentative.push({ foreignPattern, zhForm, note });
}

// 按 zh 分组合并
const byZh = new Map();
for (const t of tentative) {
  if (!byZh.has(t.zhForm)) {
    byZh.set(t.zhForm, { patterns: new Set(), zh: t.zhForm, note: "" });
  }
  const e = byZh.get(t.zhForm);
  e.patterns.add(t.foreignPattern);
  if (t.note && !e.note) e.note = t.note;
}

// 自动把 canonical zh 加入 CJK patterns（让从中文方向也能命中），但有 4 个收紧条件，
// 否则会出现误注入（如 "太阳能板在里面/包含" → "包含" 被错误绑定到 "panel iko ndani"）：
//   1. 必须是干净单一形式（不含 / 分隔的备选）
//   2. 必须是纯中文（不混 Latin）
//   3. 长度 ≥ 2（避免 1 字误匹配高频字）
//   4. 不在常见单字黑名单（如 "是"="ndio" 在「这是」里会误触发）
const COMMON_CN_BLACKLIST = new Set(["是", "的", "了", "在", "和", "包", "货", "钱", "好", "对", "用", "做"]);
for (const [zh, entry] of byZh) {
  const t = zh.trim();
  if (
    isCJK(t) &&
    !hasLatin(t) &&
    !t.includes("/") &&
    !t.includes("／") &&
    t.length >= 2 &&
    !COMMON_CN_BLACKLIST.has(t)
  ) {
    entry.patterns.add(t);
  }
}

const entries = [];
for (const [zh, entry] of byZh) {
  const patterns = [...entry.patterns].filter(Boolean);
  patterns.sort((a, b) => {
    const aCJK = isCJK(a), bCJK = isCJK(b);
    if (aCJK !== bCJK) return aCJK ? 1 : -1;
    return a.localeCompare(b);
  });
  const foreignPatterns = patterns.filter((p) => !isCJK(p));
  const en = foreignPatterns.slice(0, 5).join(" / ") || zh;

  const out = { patterns, zh, en };
  if (entry.note) out.note = entry.note;
  entries.push(out);
}

entries.sort((a, b) => a.patterns[0].localeCompare(b.patterns[0]));

writeFileSync(
  join(__dirname, "..", "local-glossary.json"),
  JSON.stringify(entries, null, 2),
  "utf8"
);

const totalPatterns = entries.reduce((n, e) => n + e.patterns.length, 0);
console.log(`✓ Wrote local-glossary.json`);
console.log(`  raw lines    : ${lines.length}`);
console.log(`  parsed       : ${tentative.length}`);
console.log(`  skipped      : ${skipped.length}`);
console.log(`  entries      : ${entries.length}`);
console.log(`  patterns     : ${totalPatterns}`);
console.log(`  avg patterns : ${(totalPatterns / entries.length).toFixed(1)} / entry`);

if (skipped.length > 0) {
  console.log(`\nSkipped lines:`);
  for (const s of skipped) console.log(`  - ${s.line}  (${s.reason})`);
}
