---
name: jupyter
description: Чтение, изменение, выполнение и конвертация Jupyter-ноутбуков программно. Используй при работе с файлами .ipynb для задач обработки данных, включая редактирование ячеек, очистку выводов или конвертацию в другие форматы.
triggers:
- ipynb
- jupyter
---

# Руководство по Jupyter Notebook

Ноутбуки — это JSON-файлы. Ячейки находятся в `nb['cells']`, каждая имеет `source` (список строк) и `cell_type` ('code', 'markdown' или 'raw').

## Изменение ноутбуков
```python
import json
with open('notebook.ipynb') as f:
    nb = json.load(f)
# Изменить nb['cells'][i]['source'], затем:
with open('notebook.ipynb', 'w') as f:
    json.dump(nb, f, indent=1)
```

## Выполнение и конвертация
```bash
jupyter nbconvert --to notebook --execute --inplace notebook.ipynb  # Выполнить на месте
jupyter nbconvert --to html notebook.ipynb      # Конвертировать в HTML
jupyter nbconvert --to script notebook.ipynb    # Конвертировать в Python
jupyter nbconvert --to markdown notebook.ipynb  # Конвертировать в Markdown
```

## Поиск кода
```bash
grep -n "search_term" notebook.ipynb
```

Эквивалент в PowerShell:

```powershell
Select-String -Path notebook.ipynb -Pattern "search_term"
```

## Структура ячейки
```python
# Ячейка кода
{"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": ["code\n"]}
# Markdown-ячейка
{"cell_type": "markdown", "metadata": {}, "source": ["# Title\n"]}
```

## Очистка выводов
```python
for cell in nb['cells']:
    if cell['cell_type'] == 'code':
        cell['outputs'] = []
        cell['execution_count'] = None
```
