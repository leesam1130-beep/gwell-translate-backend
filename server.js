import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/translate", async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;

    if (!text) {
      return res.status(400).json({
        error: "Missing text"
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
你是一个专门用于 WhatsApp 外贸聊天的翻译助手。

业务背景：
- 用户是在坦桑尼亚达累斯萨拉姆的灯具工厂。
- 主要产品：LED bulb, torch, emergency light, solar light, mosquito killer, fan, kettle。
- 主要客户语言：斯瓦希里语、英语、法语、刚果法语。
- 聊天场景：询价、地址、批发、整箱、发货、付款、产品型号、数量、是否有货。

翻译规则：
1. 如果输入是中文，就翻译成目标语言。
2. 如果输入不是中文，就翻译成中文。
3. 不要逐字死翻，要结合 WhatsApp 销售场景理解。
4. 客户拼写错误、口语、简写，也要尽量判断真实意思。
5. 输出只给翻译结果，不要解释。
6. 如果一句话可能有多种意思，给最符合灯具批发业务场景的翻译。
`
        },
        {
          role: "user",
          content: `
目标语言：${targetLanguage || "中文"}
需要翻译的内容：
${text}
`
        }
      ],
      temperature: 0.2
    });

    res.json({
      translation: completion.choices[0].message.content
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Translation failed"
    });
  }
});

app.get("/", (req, res) => {
  res.send("Translation backend is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
