---
name: office-files
description: Работа с офисными файлами — Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF. Используй, когда пользователь просит создать/прочитать/править документ Word, таблицу Excel, презентацию PowerPoint, отчёт в PDF, или прислал такой файл. Библиотеки python-docx, openpyxl, xlsxwriter, python-pptx, pandas, pypdf и pdftotext УЖЕ ПРЕДУСТАНОВЛЕНЫ в образе — НЕ запускай pip install для них.
triggers:
  - word
  - docx
  - excel
  - xlsx
  - таблицу excel
  - powerpoint
  - pptx
  - презентац
  - документ word
  - ворд
  - эксель
---

# Офисные файлы: Word / Excel / PowerPoint / PDF

## ГЛАВНОЕ: библиотеки уже установлены

В образе AgentHaus предустановлены: `python-docx`, `openpyxl`, `xlsxwriter`,
`python-pptx`, `pandas`, `pypdf`, а также `pdftotext` (poppler-utils).
**Не трать шаги на `pip install`** — сразу пиши python-скрипт и запускай.
Если импорт всё же упал (нестандартное окружение) — только тогда ставь:
`pip install --no-cache-dir <пакет>`.

Готовые файлы сохраняй в рабочую директорию диалога — пользователь видит их
в файловой вкладке Canvas (на хосте — `./projects/...`). Отправить файл
пользователю: `notify email --attach файл` или `notify telegram --attach файл`.

## Word (.docx) — python-docx

```python
from docx import Document
from docx.shared import Pt, Cm

doc = Document()                      # или Document("входящий.docx") для правки
doc.add_heading("Отчёт", level=1)
doc.add_paragraph("Обычный абзац текста.")
t = doc.add_table(rows=1, cols=3); t.style = "Table Grid"
t.rows[0].cells[0].text = "Колонка 1"
doc.add_picture("chart.png", width=Cm(15))
doc.save("отчёт.docx")

# Чтение: [p.text for p in Document("файл.docx").paragraphs]
```

## Excel (.xlsx) — openpyxl / pandas / xlsxwriter

```python
# Чтение и разбор данных — pandas (поверх openpyxl):
import pandas as pd
df = pd.read_excel("входящий.xlsx", sheet_name=0)   # все листы: sheet_name=None
print(df.head().to_string())

# Запись с форматированием/диаграммами — xlsxwriter:
with pd.ExcelWriter("итог.xlsx", engine="xlsxwriter") as w:
    df.to_excel(w, sheet_name="Данные", index=False)

# Точечная правка существующего файла (сохраняет формулы/стили) — openpyxl:
from openpyxl import load_workbook
wb = load_workbook("файл.xlsx"); ws = wb.active
ws["B2"] = 42; wb.save("файл.xlsx")
```

## PowerPoint (.pptx) — python-pptx

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()                  # или Presentation("шаблон.pptx")
slide = prs.slides.add_slide(prs.slide_layouts[1])   # 0=титул, 1=заголовок+текст
slide.shapes.title.text = "Заголовок слайда"
slide.placeholders[1].text = "• пункт один\n• пункт два"
slide.shapes.add_picture("chart.png", Inches(1), Inches(2), width=Inches(8))
prs.save("презентация.pptx")
```

## PDF

```bash
pdftotext -layout входящий.pdf -        # текст из PDF в stdout
```
```python
from pypdf import PdfReader, PdfWriter  # объединение/разбиение/страницы
```
Создание PDF: надёжнее всего собрать HTML/Markdown и сказать пользователю,
что PDF-конвертация доступна при сборке образа с LibreOffice (см. ниже).

## Входящие файлы

| Откуда | Как получить |
|---|---|
| Пользователь прикрепил в Canvas | файл уже в рабочей директории диалога — просто открой его |
| Вложение письма | `notify read --uid N --save-attachments ./attachments` |
| Файл лежит в проектах | ищи в рабочей директории (`/projects/...`) |

Первым делом определи формат по расширению и заголовку файла (`file файл`),
а не доверяй имени вслепую.

## Legacy-форматы (.doc, .xls, .ppt) и конвертация в PDF

Предустановленные библиотеки работают с современными форматами (docx/xlsx/
pptx). Для старых бинарных .doc/.xls/.ppt и конвертации документов в PDF
нужен LibreOffice, который в образ по умолчанию не включён (~700 МБ).
Если он есть (`soffice --version` отвечает):

```bash
soffice --headless --convert-to pdf отчёт.docx --outdir .
soffice --headless --convert-to docx старый.doc --outdir .
```

Если его нет — скажи пользователю один раз: «Пересобери образ с
`docker compose build --build-arg WITH_LIBREOFFICE=1`, чтобы включить
конвертацию в PDF и поддержку legacy-форматов».

## Правила

- Не изменяй входящий файл пользователя на месте без явной просьбы —
  сохраняй результат в новый файл (`отчёт_v2.docx`).
- Кириллица: везде UTF-8; в pandas при чтении CSV указывай
  `encoding="utf-8"` или `encoding="cp1251"`, если файл из старого Excel.
- Большие Excel: читай нужные колонки (`usecols=`), не грузи всё в память.
