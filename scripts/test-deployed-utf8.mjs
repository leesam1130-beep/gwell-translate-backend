// 用 Node fetch 测试 deployed backend，避免 PowerShell 中文编码污染。
const URL = "https://gwell-translate-backend-production.up.railway.app/api/translate";

const tests = [
  {
    name: "T1 复现你截图(Sw客户问Kahama,前端检出 Swahili)",
    body: {
      sourceText: "我们在卡哈马这里客户很少。",
      overrideLanguage: "Swahili",
      contextHint: { phoneLangHint: "Swahili" }
    },
    expectKeywords: ["wateja", "kahama", "wachache"]
  },
  {
    name: "T2 长公告→Swahili(发货今晚到达Dar)",
    body: {
      sourceText: "您好，烤箱已发货，今晚到达累斯萨拉姆，请准备好仓库收货。",
      overrideLanguage: "Swahili",
      contextHint: { phoneLangHint: "Swahili" }
    },
    expectKeywords: ["mzigo", "salaam", "stoo|ghala|bohari"]
  },
  {
    name: "T3 业务细节(3箱+GL-A60+批发价)→English",
    body: {
      sourceText: "好的，明天发货，3 箱 GL-A60 灯泡，价格已经按批发价算给您。",
      overrideLanguage: "English",
      contextHint: { phoneLangHint: "English" }
    },
    expectKeywords: ["3", "GL-A60", "wholesale|whole sale"]
  },
  {
    name: "T4 emoji客户TZ电话兜底→Swahili",
    body: {
      sourceText: "您好，请发地址给我，我安排送货。",
      overrideLanguage: "Swahili",
      contextHint: { phoneLangHint: "Swahili", phone: "+255700000000" }
    },
    expectKeywords: ["anwani", "tutaleta|delivery|tutatuma|kuleta"]
  },
  {
    name: "T5 法语客户(DRC)→French",
    body: {
      sourceText: "您好，请把发货地址发给我。",
      overrideLanguage: "French",
      contextHint: { phoneLangHint: "French" }
    },
    expectKeywords: ["adresse", "livraison|envoi"]
  },
  {
    name: "T6 短确认→Swahili",
    body: {
      sourceText: "好的，明白了，明天我们安排发货。",
      overrideLanguage: "Swahili",
      contextHint: { phoneLangHint: "Swahili" }
    },
    expectKeywords: ["sawa|nimeelewa", "kesho", "tutatuma|tunatuma"]
  },
  {
    name: "T7 兼容旧客户端：不传override，靠phoneHint+255→Swahili",
    body: {
      sourceText: "您好，今天我们工厂正常工作。如需下单请联系。",
      contextHint: { phoneLangHint: "Swahili", phone: "+255712345678" }
    },
    expectKeywords: ["leo", "kiwanda|factory", "kawaida|inafanya"]
  }
];

console.log("================ E2E 测试（UTF-8 正确编码） ================\n");
let pass = 0, fail = 0;
for (const t of tests) {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(t.body)
    });
    const data = await res.json();

    const trans = (data.translation || "").toLowerCase();
    const hits = t.expectKeywords.filter((kw) => {
      const re = new RegExp(kw, "i");
      return re.test(trans);
    });
    const ok = hits.length >= Math.ceil(t.expectKeywords.length * 0.5);
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✓ PASS" : "✗ FAIL"} | ${t.name}`);
    console.log(`         src         : ${t.body.sourceText}`);
    console.log(`         override    : ${t.body.overrideLanguage || "(none)"}`);
    console.log(`         target      : ${data.targetLanguage} [from ${data.targetSource}]`);
    console.log(`         translation : ${data.translation}`);
    console.log(`         keyword hits: ${hits.length}/${t.expectKeywords.length} [${hits.join(", ")}]`);
    console.log(`         provider    : ${data.provider}`);
    console.log("");
  } catch (e) {
    fail++;
    console.log(`✗ ERROR | ${t.name} → ${e.message}`);
    console.log("");
  }
}
console.log(`---\n结果: ${pass} pass / ${fail} fail`);
