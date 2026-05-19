# PPTX 簡報生成 — Skill Guide

## Overview
用 Node.js 生成精美的 PowerPoint 簡報（.pptx），搭配 AI 生成的插圖。

## Tech Stack
- **pptxgenjs** — PPTX 生成套件（`npm install pptxgenjs`）
- **Gemini API** — AI 圖片生成（gemini-2.5-flash-image 模型）
- **Node.js** — 執行環境

## Prerequisites
- Node.js 18+
- `npm install pptxgenjs`（在 workspace 裡安裝）
- 環境變數 `GEMINI_API_KEY`（可選，沒有就跳過圖片生成）

---

## 設計規範

### 配色原則（淡色簡潔風）
```javascript
const WHITE = 'FFFFFF';      // 主背景
const BG = 'F8F9FA';         // 次要背景（淺灰）
const DARK = '2D3436';       // 主文字色
const SUB = '636E72';        // 副文字色
const ACCENT = '0984E3';     // 主色（藍）
const GREEN = '00B894';      // 正面/成功
const RED = 'D63031';        // 負面/問題
const ORANGE = 'E17055';     // 警告/注意
const PURPLE = '6C5CE7';     // 輔助色

// 淡色色塊（用於卡片背景）
const LIGHT_BLUE = 'E3F2FD';
const LIGHT_GREEN = 'E8F5E9';
const LIGHT_RED = 'FFEBEE';
const LIGHT_PURPLE = 'EDE7F6';
const LIGHT_ORANGE = 'FFF3E0';
```

### 版面原則
1. **白底為主** — 背景用 WHITE 或 BG
2. **頂部色帶** — 每頁最上方加 0.06 高度的色帶作為視覺分隔
3. **卡片式排版** — 用 ROUNDED_RECTANGLE + shadow 作為內容區塊
4. **不用 emoji** — 用純色圓形圖標或 AI 插圖取代
5. **字體** — 中文用 'Microsoft JhengHei'，英文用預設

### 字級規範
| 用途 | 字級 |
|------|------|
| 大標題 | 34-36 |
| 頁面標題 | 22-24 |
| 小標題 | 13-14 |
| 內文 | 11-12 |
| 註解/標籤 | 10 |
| 表格內文 | 9.5-10.5 |

### 卡片樣式
```javascript
s.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
  x, y, w, h,
  fill: { color: 'FFFFFF' },
  rectRadius: 0.1,
  shadow: { type: 'outer', blur: 5, opacity: 0.06, offset: 2, color: '000000' },
});
```

### 圖片使用方式
```javascript
// 半頁圖：圖片放右半邊，文字放左半邊
s.addImage({ path: '/tmp/img.png', x: 5, y: 0, w: 5, h: 5.63, sizing: { type: 'cover', w: 5, h: 5.63 } });

// 全頁背景 + 遮罩
s.addImage({ path: '/tmp/img.png', x: 0, y: 0, w: 10, h: 5.63, sizing: { type: 'cover', w: 10, h: 5.63 } });
s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 5.63, fill: { color: 'FFFFFF', transparency: 20 } });
```

---

## AI 圖片生成（Gemini）

### 生成函式
```javascript
async function generateImage(prompt, filename) {
  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) { console.log('No GEMINI_API_KEY, skipping image:', filename); return false; }

  const URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
  };

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      const fs = require('fs');
      fs.writeFileSync(filename, Buffer.from(part.inlineData.data, 'base64'));
      return true;
    }
  }
  return false;
}
```

### Prompt 技巧
- 開頭加 "Generate a wide 16:9 landscape image:"
- 結尾加 "no text, no letters, no words"
- 風格關鍵字：flat design, minimalist, corporate illustration, pastel colors
- 每張圖之間間隔 4-5 秒避免 rate limit

### 常見主題 Prompt 範例
```
封面：... team leader guiding staff in bright modern office, soft pastel blue and white ...
問題頁：... chaotic tangled communication lines between confused workers, pastel red and gray ...
方案頁：... streamlined efficient workflow with organized arrows, pastel blue and green ...
時程頁：... horizontal timeline with connected circles showing progression, pastel blue ...
成功頁：... team celebrating achievement with checkmarks, warm pastel tones ...
```

### 注意事項
- ❌ `gemini-2.0-flash` 不支援圖片輸出
- ❌ `imageDimension` 參數不存在，不要加
- ❌ `imagen-3.0-generate-002` 需要 Vertex，普通 API key 不行
- ✅ 只有 `gemini-2.5-flash-image` 和 `gemini-3-pro-image-preview` 可用

---

## 簡報結構模板（10-14 頁）

```
1. 封面（標題 + 副標 + 右側插圖）
2. 現況/問題（痛點列表 + 問題插圖背景）
3. 解決方案總覽（核心概念 + 流程圖）
4. 方案細節 ×3-4 頁（每頁一個重點 + Before/After 或表格）
5. 執行計畫/時程（Timeline）
6. 總結（一句話核心 + 3-4 個重點回顧）
7. (選用) 待確認/Q&A
```

---

## 常見元素寫法

### 頂部色帶
```javascript
s.addShape(pptx.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: ACCENT } });
```

### 編號圓圈
```javascript
s.addShape(pptx.shapes.OVAL, { x: 0.8, y: 0.4, w: 0.5, h: 0.5, fill: { color: ACCENT } });
s.addText('1', { x: 0.8, y: 0.4, w: 0.5, h: 0.5, fontSize: 14, fontFace: FONT, color: 'FFFFFF', bold: true, align: 'center', valign: 'middle' });
```

### Before/After 對比
```javascript
// 左邊：問題（淡紅底）
s.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 0.5, y: 1.5, w: 4.3, h: 2.5, fill: { color: 'FFEBEE' }, rectRadius: 0.08 });
// 右邊：解法（淡綠底）
s.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x: 5.2, y: 1.5, w: 4.3, h: 2.5, fill: { color: 'E8F5E9' }, rectRadius: 0.08 });
```

### Timeline
```javascript
items.forEach((item, i) => {
  const y = 1.2 + i * 0.85;
  s.addShape(pptx.shapes.OVAL, { x: 1.5, y: y + 0.08, w: 0.3, h: 0.3, fill: { color: ACCENT } });
  if (i < items.length - 1) {
    s.addShape(pptx.shapes.RECTANGLE, { x: 1.63, y: y + 0.38, w: 0.04, h: 0.5, fill: { color: 'DFE6E9' } });
  }
  s.addText(item.label, { x: 2.0, y, w: 1.5, h: 0.4, fontSize: 12, fontFace: FONT, color: ACCENT, bold: true });
  s.addText(item.content, { x: 3.5, y, w: 5, h: 0.4, fontSize: 12, fontFace: FONT, color: DARK });
});
```

### 表格
```javascript
const tableData = [
  [{ text: '欄位', options: { bold: true, color: 'FFFFFF', fill: { color: ACCENT } } }, ...],
  [{ text: '內容', options: { color: DARK, fill: { color: i % 2 === 0 ? BG : WHITE } } }, ...],
];
s.addTable(tableData, {
  x: 0.5, y: 1.5, w: 9.0,
  fontSize: 10.5, fontFace: FONT,
  border: { type: 'solid', pt: 0.5, color: 'DFE6E9' },
  align: 'center', valign: 'middle',
});
```

---

## 執行流程

1. **分析內容** — 理解要傳達的訊息，決定頁數和結構
2. **生成圖片** — 用 Gemini 生成 4-6 張主題插圖（沒有 API key 就跳過）
3. **建立腳本** — 寫 `gen_pptx.cjs` 檔案
4. **執行生成** — `node gen_pptx.cjs`
5. **回報路徑** — 告訴 user .pptx 檔案在哪裡

---

## 品質 Checklist

- [ ] 每頁都有頂部色帶
- [ ] 文字對比度足夠（深色字 on 淺色底）
- [ ] 表格有交錯背景色
- [ ] 卡片有圓角和陰影
- [ ] 圖片不壓到文字（有遮罩或分區）
- [ ] 不使用 emoji（用純色圖形取代）
- [ ] 字級層次分明（標題 > 小標 > 內文 > 註解）
- [ ] 每頁重點不超過 4-5 個
