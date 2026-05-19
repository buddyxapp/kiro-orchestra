# Office Document Read & Modify — Skill Guide

## Overview
讀取、分析、修改現有的 Excel/Word/PowerPoint 檔案。

## Prerequisites
```bash
# Python 套件（修改用）
pip install python-pptx openpyxl python-docx

# Node.js 套件（Excel 讀寫用）
npm install xlsx

# LibreOffice（視覺分析用 — 轉圖片）
# Windows: choco install libreoffice 或手動安裝
# Mac: brew install libreoffice
```

---

## 讀取策略

### 方式 1：視覺分析（推薦 — 能看到版面/圖表/格式）

用 LibreOffice 轉成圖片，再用 read tool Image mode 分析：

```bash
# PPT → 每頁一張 PNG
soffice --headless --convert-to png input.pptx --outdir /tmp/slides/

# Excel → PNG（整個 sheet）
soffice --headless --convert-to png input.xlsx --outdir /tmp/sheets/

# Word → PNG（每頁）
soffice --headless --convert-to png input.docx --outdir /tmp/pages/
```

然後用 read tool (Image mode) 讀取圖片，AI 能分析：
- 版面佈局
- 圖表類型和數據趨勢
- 配色和字體風格
- 表格結構

### 方式 2：結構化讀取（拿數據）

**Excel：**
```javascript
const XLSX = require('xlsx');
const wb = XLSX.readFile('input.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws);
console.log(JSON.stringify(data, null, 2));
```

**Word：**
```python
from docx import Document
doc = Document('input.docx')
for para in doc.paragraphs:
    print(f"[{para.style.name}] {para.text}")
for table in doc.tables:
    for row in table.rows:
        print([cell.text for cell in row.cells])
```

**PowerPoint：**
```python
from pptx import Presentation
prs = Presentation('input.pptx')
for i, slide in enumerate(prs.slides):
    print(f"--- Slide {i+1} ---")
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text)
        if shape.has_table:
            for row in shape.table.rows:
                print([cell.text for cell in row.cells])
```

---

## 修改現有檔案

### Excel 修改（openpyxl）

```python
from openpyxl import load_workbook

wb = load_workbook('input.xlsx')
ws = wb.active

# 修改儲存格
ws['B2'] = '新的值'
ws['C5'] = 12345

# 修改整列
for row in ws.iter_rows(min_row=2, max_row=10, min_col=3, max_col=3):
    for cell in row:
        cell.value = cell.value * 1.1  # 加 10%

wb.save('output.xlsx')
```

### Word 修改（python-docx）

```python
from docx import Document

doc = Document('input.docx')

# 替換文字（保留格式）
for para in doc.paragraphs:
    if '舊文字' in para.text:
        for run in para.runs:
            run.text = run.text.replace('舊文字', '新文字')

# 修改表格
table = doc.tables[0]
table.cell(1, 2).text = '更新的數據'

doc.save('output.docx')
```

### PowerPoint 修改（python-pptx）

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation('input.pptx')

# 修改指定 slide 的文字
slide = prs.slides[2]  # 第 3 頁
for shape in slide.shapes:
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                if '舊標題' in run.text:
                    run.text = run.text.replace('舊標題', '新標題')

# 替換圖片
from pptx.util import Inches
slide = prs.slides[0]
for shape in slide.shapes:
    if shape.shape_type == 13:  # Picture
        left, top, width, height = shape.left, shape.top, shape.width, shape.height
        slide.shapes._spTree.remove(shape._element)
        slide.shapes.add_picture('new_image.png', left, top, width, height)
        break

# 修改表格數據
slide = prs.slides[3]
for shape in slide.shapes:
    if shape.has_table:
        table = shape.table
        table.cell(1, 2).text = '$450,000'
        break

prs.save('output.pptx')
```

---

## 常見任務範例

### 「更新 PPT 裡的數字」
1. `soffice --convert-to png input.pptx` → 看圖確認哪頁要改
2. 用 python-pptx 讀取 → 找到目標文字 → 替換
3. 存檔

### 「把 Excel 數據填入 PPT 表格」
1. 用 xlsx 讀 Excel 數據
2. 用 python-pptx 開 PPT → 找到表格 → 填入數據
3. 存檔

### 「分析 PPT 風格，做一份類似的新簡報」
1. LibreOffice 轉圖 → AI 分析版面/配色/字體
2. 用 pptx-generation.md 的方法從零生成（效果更好）

---

## 注意事項

- ⚠️ python-pptx 修改後可能丟失動畫/轉場效果
- ⚠️ openpyxl 不支援 .xls（舊格式），只支援 .xlsx
- ⚠️ LibreOffice 轉圖品質很好但速度慢（大檔案 5-10 秒）
- ✅ 修改操作保留原始格式和版面（只改指定內容）
- ✅ 建議先備份原檔再修改
