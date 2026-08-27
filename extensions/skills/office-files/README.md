# office-files — Word / Excel / PowerPoint / PDF

Навык-шпаргалка для работы с офисными форматами. Главная задача — сообщить
агенту, что библиотеки **уже предустановлены в образе** (см. `docker/Dockerfile`),
и дать готовые рецепты, чтобы он не тратил шаги на `pip install` и поиск API.

## Предустановлено в образе

| Библиотека | Формат | Назначение |
|---|---|---|
| python-docx | .docx | создание/чтение/правка Word |
| openpyxl | .xlsx | чтение/запись Excel, точечная правка |
| xlsxwriter | .xlsx | быстрая запись, диаграммы, форматирование |
| python-pptx | .pptx | презентации PowerPoint |
| pandas | .xlsx/.csv | разбор и аналитика таблиц |
| pypdf | .pdf | объединение/разбиение PDF |
| poppler-utils | .pdf | `pdftotext` — извлечение текста |

Опционально (build-arg `WITH_LIBREOFFICE=1`): LibreOffice headless —
конвертация в PDF и legacy .doc/.xls/.ppt.

## Входящие файлы

- вложение в Canvas → уже в рабочей директории диалога;
- вложение письма → `notify read --uid N --save-attachments ./attachments`;
- подробности: `docs/OFFICE_FILES_RU.md` в корне репозитория.
