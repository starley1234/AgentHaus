#!/usr/bin/env bash
# Сканирование сигналов Политик и управления (Столп 4)

REPO="${1:-.}"
cd "$REPO" 2>/dev/null || { echo "Не могу получить доступ к $REPO"; exit 1; }

echo "=== Столп 4: Политики и управление ==="
echo ""

echo "-- .gitignore --"
if [ -f .gitignore ]; then
  lines=$(wc -l < .gitignore | tr -d ' ')
  echo "./.gitignore ($lines строк)"
  agent_entries=$(grep -ci 'cursor\|claude\|copilot\|\.agent\|\.mcp' .gitignore 2>/dev/null)
  [ "$agent_entries" -gt 0 ] && echo "  ($agent_entries записей, связанных с агентом, в ignore)"
else
  echo "  (не найдено)"
fi

echo ""
echo "-- Лицензия --"
find . -maxdepth 1 -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'MIT-LICENSE' 2>/dev/null | sort

echo ""
echo "-- Владение кодом --"
find . -maxdepth 3 -name 'CODEOWNERS' 2>/dev/null | sort
if [ -f CODEOWNERS ] || [ -f .github/CODEOWNERS ] || [ -f docs/CODEOWNERS ]; then
  f=$(find . -maxdepth 3 -name 'CODEOWNERS' 2>/dev/null | head -1)
  rules=$(grep -c '^[^#]' "$f" 2>/dev/null | tr -d ' ')
  echo "  ($rules правил владения)"
fi

echo ""
echo "-- Политика безопасности --"
find . -maxdepth 3 -iname 'SECURITY*' 2>/dev/null | sort

echo ""
echo "-- Кодекс поведения --"
find . -maxdepth 2 -iname 'CODE_OF_CONDUCT*' -o -iname 'CONDUCT*' 2>/dev/null | sort

echo ""
echo "-- Политика использования AI --"
for f in AGENTS.md CLAUDE.md CONTRIBUTING.md; do
  if [ -f "$f" ]; then
    ai_mentions=$(grep -ci 'ai policy\|ai usage\|agent boundar\|ai contribut\|llm\|copilot' "$f" 2>/dev/null)
    [ "$ai_mentions" -gt 0 ] && echo "  $ai_mentions ссылок на AI-политику в $f"
  fi
done

echo ""
echo "-- Управление секретами --"
if [ -d .github/workflows ]; then
  secrets_refs=$(grep -roh '\${{ secrets\.[A-Z_]*' .github/workflows/ 2>/dev/null | sort -u | wc -l | tr -d ' ')
  echo "  $secrets_refs различных секретов, упомянутых в CI"
fi
find . -maxdepth 2 -name '.env.example' -o -name '.env.template' 2>/dev/null | sort
find . -maxdepth 2 -name 'vault.hcl' -o -name '.vault-token' 2>/dev/null | sort

echo ""
echo "-- Сканирование безопасности --"
if [ -d .github/workflows ]; then
  for scanner in codeql snyk trivy gosec semgrep; do
    grep -ril "$scanner" .github/workflows/ 2>/dev/null | while read f; do
      echo "  $scanner в $(basename "$f")"
    done
  done
fi
find . -maxdepth 2 -name '.snyk' -o -name '.trivyignore' 2>/dev/null | sort

echo ""
echo "-- Git-атрибуты --"
if [ -f .gitattributes ]; then
  lines=$(wc -l < .gitattributes | tr -d ' ')
  echo "./.gitattributes ($lines строк)"
  linguist=$(grep -c 'linguist' .gitattributes 2>/dev/null)
  [ "$linguist" -gt 0 ] && echo "  ($linguist переопределений linguist)"
  lfs=$(grep -c 'filter=lfs' .gitattributes 2>/dev/null)
  [ "$lfs" -gt 0 ] && echo "  ($lfs паттернов, отслеживаемых LFS)"
else
  echo "  (не найдено)"
fi

echo ""
echo "-- Соглашение участника --"
find . -maxdepth 2 -iname 'DCO*' -o -iname 'CLA*' 2>/dev/null | sort
for f in CONTRIBUTING.md .github/workflows/*.yml; do
  [ -f "$f" ] && grep -qi 'signed-off-by\|DCO\|CLA\|contributor license' "$f" 2>/dev/null \
    && echo "  Ссылка DCO/CLA в $(basename "$f")"
done

echo ""
echo "-- Модель управления --"
find . -maxdepth 2 -iname 'GOVERNANCE*' -o -iname 'MAINTAINERS*' -o -iname 'OWNERS*' 2>/dev/null | sort

echo ""
echo "-- Валидация CI workflow --"
if [ -d .github/workflows ]; then
  grep -rl 'actionlint' .github/workflows/ 2>/dev/null | head -3
fi
if [ -f .pre-commit-config.yaml ]; then
  grep -q 'actionlint' .pre-commit-config.yaml 2>/dev/null && echo "  actionlint в pre-commit"
fi

echo ""
echo "-- Разделение окружений --"
find . -maxdepth 2 -name '.env.test' -o -name '.env.production' -o -name '.env.staging' \
  -o -name '.env.development' 2>/dev/null | sort
for d in config/environments environments; do
  [ -d "$d" ] && echo "./$d/ ($(ls "$d" | wc -l | tr -d ' ') окружений)"
done
