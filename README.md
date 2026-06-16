# GWELL Translate Backend

为 GWELL WhatsApp CRM Chrome 扩展提供翻译能力的后端服务。

**双 provider 架构（2026-06）**：默认走 Google Gemini（`gemini-2.5-flash`），OpenAI 当容灾备份。任一失败/被安全过滤拦截时自动切到另一家。
所有 API Key 只存在这里的环境变量里，**永远不会**下发到任何插件 / 浏览器。

## 文件清单（这些都要放到后端仓库 / Railway）

```
gwell-translate-backend-deploy/
├── server.js          # Express 服务源码（所有 prompt / JSON Schema 都在里面）
├── package.json       # 依赖声明（express / cors / dotenv）
├── package-lock.json  # 锁定依赖版本，构建复现用
├── .env.example       # 环境变量模板（提交进 git）
├── .gitignore         # 排除 node_modules / .env
└── README.md          # 本文档
```

**不要上传**：

- `node_modules/`（Railway 会自己跑 `npm ci`）
- `.env`（真实密钥，只放本地 / Railway 的 Variables 面板）

## 本地开发

```bash
npm install
cp .env.example .env       # 然后把真实的 OPENAI_API_KEY 填进去
npm start
```

启动后 `http://localhost:3000/api/health` 应返回 `{"ok":true,"hasKey":true}`。

## 部署到 Railway

1. 把这个目录推到一个 GitHub 仓库。
2. Railway → New Project → Deploy from GitHub repo → 选这个仓库。
3. 进 Project → Variables，加：
   - `GEMINI_API_KEY` = `...`（推荐填，主 provider；从 https://aistudio.google.com/app/apikey 创建）
   - `OPENAI_API_KEY` = `sk-...`（推荐填，容灾备份）
   - 任填一个也能跑，但少一个就没自动容灾
   - `GWELL_PRIMARY_PROVIDER` = `gemini` 或 `openai`（可选，默认 `gemini`）
   - `GWELL_GEMINI_MODEL` = `gemini-2.5-flash`（可选，默认即此；不要再用 2.0-flash，已 EOL）
4. Railway 会自动检测 `package.json` → 跑 `npm install` → `npm start`。
5. 在 Settings → Networking → Generate Domain 拿到公网 URL。
6. 把 URL 同步到 Chrome 扩展的 `background.js` (`BACKEND_BASE_URL`) 和 `manifest.json` (`host_permissions`)。

## API

| 方法 + 路径 | 用途 |
|---|---|
| `GET /` | 健康检查（返回纯文本） |
| `GET /api/health` | 健康检查（返回 `{ok, hasKey, hasGeminiKey, primaryProvider, geminiModel, ...}`），插件"测试连接"用 |
| `POST /api/translate` | 中文 → 客户语言（含语种识别）。**走 provider 路由**：默认 Gemini，失败自动切 OpenAI。 |
| `POST /api/batch-translate-incoming` | 批量来信 → 中文。**走 provider 路由**。意图分类已移除（用户自行分析）。 |
| `POST /intent` | 意图识别（本地关键词优先，AI fallback；OpenAI 直连） |
| `POST /quote` | 产品报价（OpenAI 直连） |
| `POST /translate` | 旧的简易翻译端点（向后兼容；OpenAI 直连） |

### `POST /api/translate`

请求：
```json
{
  "sourceText": "你好，烤箱已发货",
  "customerMessages": [{ "text": "...", "time": "..." }],
  "overrideLanguage": null,
  "contextHint": { "name": "...", "phone": "+255...", "subtitle": "..." },
  "model": "gpt-4o-mini"
}
```

响应：
```json
{
  "ok": true,
  "detectedLanguage": "Swahili",
  "detectedLanguageConfidence": "high",
  "translation": "...",
  "usage": { "input_tokens": 280, "output_tokens": 30, "total_tokens": 310 },
  "model": "gemini-2.0-flash",
  "provider": "gemini",
  "providerFallback": false
}
```

> 客户端可在 `model` 字段里强制指定 provider：
> - `"gemini-2.0-flash"` / `"gemini-1.5-flash"` → 走 Gemini
> - `"gpt-4o-mini"` → 走 OpenAI
> - 不传/不识别 → 走 `GWELL_PRIMARY_PROVIDER` 默认（Gemini）
>
> 当 `providerFallback=true` 时表示主 provider 失败、已自动切到另一家，响应里还会带 `primaryError` 描述失败原因。

### `POST /api/batch-translate-incoming`

请求：
```json
{
  "items": [{ "id": "msg-1", "text": "Bei ya solar?" }],
  "recentContext": ["Mna taa za solar?"],
  "model": "gpt-4o-mini",
  "upgradeModel": "gpt-4o"
}
```

响应：
```json
{
  "ok": true,
  "translations": [
    {
      "id": "msg-1",
      "translation_cn": "太阳能灯多少钱？",
      "intent": "other",
      "secondary_intents": [],
      "confidence": "medium"
    }
  ],
  "usage": {},
  "upgradeUsage": null,
  "upgradedIds": [],
  "model": "gemini-2.0-flash",
  "provider": "gemini",
  "providerFallback": false,
  "upgradeModel": null
}
```

> `intent / secondary_intents / confidence` 现在是后端默认填的占位值（用户已把意图分析改成前端自己处理，详见 commit `0707740`）。
> 同样支持通过 `model` 字段切换 provider，行为与 `/api/translate` 一致。

## 安全建议（强烈推荐）

当前后端是公开的，知道 URL 就能调用。生产环境建议加：

1. **共享 Token 校验**：插件请求头加 `X-GWELL-Token`，服务端校验。
2. **Origin 白名单**：只接受 `chrome-extension://<your-extension-id>` 的请求。
3. **速率限制**：用 `express-rate-limit` 限制 IP / Token 每分钟请求数。
4. **OpenAI 支出上限**：在 OpenAI Dashboard 给这个 Key 设硬上限，万一被盗刷也有兜底。
