#!/usr/bin/env bash
# Сканирование сигналов Инструкций для агента (Столп 1)
# Помогает агенту найти релевантные файлы — не заменяет суждение.

REPO="${1:-.}"
cd "$REPO" 2>/dev/null || { echo "Не могу получить доступ к $REPO"; exit 1; }

echo "=== Столп 1: Инструкции для агента ==="
echo ""

echo "-- Файлы инструкций для агента --"
find . -maxdepth 3 -iname 'AGENTS.md' -o -iname 'CLAUDE.md' -o -iname 'COPILOT.md' \
  -o -iname 'CONVENTIONS.md' -o -iname 'CODING_GUIDELINES.md' 2>/dev/null | sort

echo ""
echo "-- Конфигурация AI IDE --"
for f in .cursor .cursor/rules .cursorrules .github/copilot-instructions.md \
         .github/instructions .claude .claude/settings.json; do
  [ -e "$f" ] && echo "./$f"
done

echo ""
echo "-- Навыки агента --"
for d in .claude/skills .factory/skills; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -type f | wc -l | tr -d ' ') файлов)"
done
find . -maxdepth 3 -iname 'skill.md' 2>/dev/null | sort

echo ""
echo "-- Конфигурация сервера инструментов --"
find . -maxdepth 2 -name '.mcp.json' -o -name 'mcp.config.*' 2>/dev/null | sort

echo ""
echo "-- Библиотека промптов агента --"
for d in .github/prompts prompts; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -type f | wc -l | tr -d ' ') файлов)"
done

echo ""
echo "-- README --"
[ -f README.md ] && echo "./README.md ($(wc -l < README.md) строк)" || echo "(не найдено)"

echo ""
echo "-- Гайд по участию --"
find . -maxdepth 2 -iname 'CONTRIBUTING*' 2>/dev/null | sort

echo ""
echo "-- Документация архитектуры --"
find . -maxdepth 3 -iname 'ARCHITECTURE*' -o -iname 'DESIGN*' 2>/dev/null | sort
for d in doc/adr docs/adr decisions rfcs doc/design; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -type f | wc -l | tr -d ' ') файлов)"
done

echo ""
echo "-- Документация API --"
find . -maxdepth 3 -name 'openapi.yaml' -o -name 'openapi.json' -o -name 'swagger.yaml' \
  -o -name 'swagger.json' 2>/dev/null | sort
find . -maxdepth 2 -name 'doc.go' 2>/dev/null | head -5
api_doc_count=$(find . -maxdepth 2 -name 'doc.go' 2>/dev/null | wc -l | tr -d ' ')
[ "$api_doc_count" -gt 5 ] && echo "  ... и ещё $((api_doc_count - 5)) файлов doc.go"

echo ""
echo "-- Журнал изменений --"
find . -maxdepth 1 -iname 'CHANGELOG*' -o -iname 'CHANGES*' -o -iname 'HISTORY*' 2>/dev/null | sort

echo ""
echo "-- Документация переменных окружения --"
find . -maxdepth 2 -name '.env.example' -o -name '.env.template' -o -name '.env.sample' 2>/dev/null | sort

echo ""
echo "-- Сайт/каталог документации --"
[ -d docs ] && echo "./docs/ ($(find docs -type f | wc -l | tr -d ' ') файлов)"
for f in docusaurus.config.* mkdocs.yml conf.py .vitepress/config.*; do
  find . -maxdepth 2 -name "$(basename "$f")" 2>/dev/null
done

echo ""
echo "-- Каталог примеров --"
for d in examples _examples; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -type f | wc -l | tr -d ' ') файлов)"
done

echo ""
echo "-- README на уровне модулей --"
find . -mindepth 2 -maxdepth 3 -name 'README.md' 2>/dev/null | head -10
readme_count=$(find . -mindepth 2 -maxdepth 3 -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')
[ "$readme_count" -gt 10 ] && echo "  ... и ещё $((readme_count - 10))"
echo "  Всего: $readme_count модульных README"
