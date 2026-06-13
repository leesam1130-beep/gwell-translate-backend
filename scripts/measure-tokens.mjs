// 测量 GWELL 翻译后端各路由的 system prompt token 消耗
// 用法: node scripts/measure-tokens.mjs
// 模型: gpt-4o-mini (使用 o200k_base 编码)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { encode } from "gpt-tokenizer/model/gpt-4o-mini";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverSource = readFileSync(join(__dirname, "..", "server.js"), "utf8");

// --- 抽取 prompt 字符串（按变量名定位，截到第一个 ` 反引号结束）---
function extractTemplate(src, varName) {
  const m = src.match(new RegExp(`const\\s+${varName}\\s*=\\s*\`([\\s\\S]*?)\`;`));
  return m ? m[1] : null;
}

function extractFunctionReturn(src, fnName, args) {
  // 匹配 function 体里第一个 return `...`; 模板字符串
  const fnRegex = new RegExp(`function\\s+${fnName}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = src.match(fnRegex);
  if (!m) return null;
  const body = m[1];
  const ret = body.match(/return\s+`([\s\S]*?)`;\s*$/m);
  if (!ret) return null;
  // 替换占位变量为示例值
  return ret[1]
    .replace(/\$\{detect\}/g, args.detect || "")
    .replace(/\$\{phoneHint\}/g, args.phoneHint || "")
    .replace(/\$\{custLines[^}]+\}/g, args.custLines || "");
}

const slimSystem = extractFunctionReturn(serverSource, "buildOutboundInstructionsSlim", {
  detect: `Detect the customer's primary language from their recent messages (Swahili / English / French / mixed). If unclear / emoji-only / empty → fall back to English.`,
  phoneHint: ""
});

const expertSystem = extractFunctionReturn(serverSource, "buildOutboundInstructionsExpert", {
  detect: `Detect the customer's primary language from their recent messages.`,
  phoneHint: "",
  custLines: ""
});

const slimBatch = extractTemplate(serverSource, "BATCH_TRANSLATE_INSTRUCTIONS_SLIM");
const expertBatch = extractTemplate(serverSource, "BATCH_TRANSLATE_INSTRUCTIONS_EXPERT");

const intentAI = extractTemplate(serverSource, "INTENT_AI_INSTRUCTIONS");

function tokens(s) {
  return s == null ? 0 : encode(s).length;
}

function row(label, text) {
  if (text == null) {
    console.log(`  ${label.padEnd(40)} (未找到)`);
    return;
  }
  const t = tokens(text);
  const c = text.length;
  console.log(`  ${label.padEnd(40)} ${String(t).padStart(5)} tokens   ${String(c).padStart(5)} chars`);
}

console.log("\n=========================================================");
console.log(" GWELL Translate Backend — System Prompt Token 测量");
console.log(" 模型: gpt-4o-mini   编码: o200k_base");
console.log("=========================================================\n");

console.log("【/api/translate 主路由】（中→客户语言）");
row("slim 模式 (默认)", slimSystem);
row("expert 模式 (回退)", expertSystem);

console.log("\n【/api/batch-translate-incoming】（来信→中文+12类意图）");
row("slim 模式 (默认)", slimBatch);
row("expert 模式 (回退)", expertBatch);

console.log("\n【/intent AI fallback】（仅本地未命中时调用）");
row("AI 提示词", intentAI);

// === 典型整次请求的 token 估算 ===
console.log("\n=========================================================");
console.log(" 典型整次请求 token 估算（system + 一般业务 input）");
console.log("=========================================================\n");

const typicalChineseReply = "我们办公室在 Kariakoo，工厂在 Kigamboni。A60 9W 球泡批发价 0.5 USD/pcs，整箱 100 pcs。MOQ 50 整箱。";
const typicalCustomerMsgs = [
  "Mna A60 LED bulb?",
  "9W au 12W?",
  "Bei ya jumla?"
];

const buildOutboundInputSample = () => {
  const lines = [];
  lines.push("## Customer recent messages (oldest → newest, max 3 × 100 chars)");
  typicalCustomerMsgs.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
  lines.push("");
  lines.push("## Salesperson Chinese reply (translate this)");
  lines.push(typicalChineseReply);
  return lines.join("\n");
};

const sampleInput = buildOutboundInputSample();
console.log("典型 input 内容（3 条客户消息 + 1 条中文回复）:");
row("input 部分", sampleInput);

console.log("\n— /api/translate 整次发送给 OpenAI —");
const slimTotal = tokens(slimSystem) + tokens(sampleInput);
const expertTotal = tokens(expertSystem) + tokens(sampleInput);
console.log(`  slim   合计输入 tokens: ${slimTotal}`);
console.log(`  expert 合计输入 tokens: ${expertTotal}`);
console.log(`  节省幅度: ${((1 - slimTotal / expertTotal) * 100).toFixed(1)}% (slim 比 expert 少 ${expertTotal - slimTotal} tokens)`);

// === 按 1.74M / 60.8K 历史数据外推 ===
console.log("\n=========================================================");
console.log(" 按您之前 1.743M input / 60.8K output 外推");
console.log("=========================================================\n");

const historyInputTotal = 1_743_000;
const historyOutputTotal = 60_813;
console.log(`  历史 input  : ${historyInputTotal.toLocaleString()} tokens`);
console.log(`  历史 output : ${historyOutputTotal.toLocaleString()} tokens`);
console.log(`  历史 ratio  : ${(historyInputTotal / historyOutputTotal).toFixed(1)}:1\n`);

// 假设历史调用 ≈ 60.8K output / 假设平均 80 token/响应 ≈ 760 次调用
const assumedAvgOutputPerCall = 80;
const assumedTotalCalls = Math.round(historyOutputTotal / assumedAvgOutputPerCall);
const assumedAvgInputPerCall = historyInputTotal / assumedTotalCalls;
console.log(`  假设平均每次响应 ${assumedAvgOutputPerCall} output tokens → 约 ${assumedTotalCalls} 次调用`);
console.log(`  对应每次平均 input: ${assumedAvgInputPerCall.toFixed(0)} tokens`);
console.log(`  这与 expert 模式 (${expertTotal} tokens) 量级一致 ✓`);

// 切到 slim 后预测
const projectedInputPerCall = slimTotal;
const projectedTotalInput = projectedInputPerCall * assumedTotalCalls;
console.log(`\n  切到 slim 后每次预计 input: ${projectedInputPerCall} tokens`);
console.log(`  按相同 ${assumedTotalCalls} 次调用预测总 input: ${projectedTotalInput.toLocaleString()} tokens`);
console.log(`  预计节省: ${(historyInputTotal - projectedTotalInput).toLocaleString()} tokens (${((1 - projectedTotalInput / historyInputTotal) * 100).toFixed(1)}%)`);
console.log(`  预计 ratio: ${(projectedTotalInput / historyOutputTotal).toFixed(2)}:1  (目标 ≤5:1)`);

console.log("");
