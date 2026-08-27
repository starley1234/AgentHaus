#!/usr/bin/env bash
# Сканирование сигналов Рабочих процессов и автоматизации (Столп 3)

REPO="${1:-.}"
cd "$REPO" 2>/dev/null || { echo "Не могу получить доступ к $REPO"; exit 1; }

echo "=== Столп 3: Рабочие процессы и автоматизация ==="
echo ""

echo "-- Шаблоны issue --"
if [ -d .github/ISSUE_TEMPLATE ]; then
  echo ".github/ISSUE_TEMPLATE/:"
  ls -1 .github/ISSUE_TEMPLATE/ 2>/dev/null | while read f; do echo "  $f"; done
else
  echo "  (не найдено)"
fi

echo ""
echo "-- Шаблон PR --"
find . -maxdepth 3 -iname 'pull_request_template*' 2>/dev/null | sort
[ -f .github/pull_request_template.md ] || echo "  (не найдено)"

echo ""
echo "-- Автоматизация обновления зависимостей --"
for f in .github/dependabot.yml .github/dependabot.yaml renovate.json .renovaterc \
         .renovaterc.json renovate.json5; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Автоматизация релизов --"
if [ -d .github/workflows ]; then
  grep -ril 'release\|publish\|deploy' .github/workflows/ 2>/dev/null | while read f; do
    echo "  $(basename "$f")"
  done
fi
for f in .releaserc .releaserc.json .releaserc.yml release-please-config.json \
         .goreleaser.yml .goreleaser.yaml; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Сигналы защиты веток --"
if [ -d .github/workflows ]; then
  grep -rl 'merge_group' .github/workflows/ 2>/dev/null | while read f; do
    echo "  триггер merge_group в $(basename "$f")"
  done
fi

echo ""
echo "-- Автоматизация мержа --"
find . -maxdepth 2 -name '.mergify.yml' -o -name 'mergify.yml' 2>/dev/null | sort
if [ -d .github/workflows ]; then
  grep -rl 'auto-merge\|automerge\|gh pr merge' .github/workflows/ 2>/dev/null | head -3
fi

echo ""
echo "-- Таск-раннер --"
for f in Makefile GNUmakefile makefile Justfile justfile Taskfile.yml taskfile.yml \
         Rakefile Earthfile; do
  [ -f "$f" ] && echo "./$f"
done
if [ -f package.json ]; then
  script_count=$(python3 -c "import json; d=json.load(open('package.json')); print(len(d.get('scripts',{})))" 2>/dev/null)
  [ -n "$script_count" ] && echo "  package.json: $script_count скриптов"
fi

echo ""
echo "-- Структурированное отслеживание изменений --"
[ -d .changeset ] && echo ".changeset/ ($(ls .changeset/*.md 2>/dev/null | wc -l | tr -d ' ') ожидающих changeset)"
find . -maxdepth 2 -name 'commitlint.config.*' -o -name '.commitlintrc*' 2>/dev/null | sort
if [ -d .github/workflows ]; then
  grep -rl 'conventional-commits\|commitlint\|semantic-pull-request' .github/workflows/ 2>/dev/null | head -3
fi

echo ""
echo "-- Контроль конкурентности CI --"
if [ -d .github/workflows ]; then
  concurrency_count=$(grep -rl 'concurrency:' .github/workflows/ 2>/dev/null | wc -l | tr -d ' ')
  cancel_count=$(grep -rl 'cancel-in-progress' .github/workflows/ 2>/dev/null | wc -l | tr -d ' ')
  echo "  $concurrency_count workflow с группами конкурентности, $cancel_count с cancel-in-progress"
fi

echo ""
echo "-- Автоматизированные заметки о релизе --"
for f in release-please-config.json .github/release.yml cliff.toml .cliff.toml; do
  [ -f "$f" ] && echo "./$f"
done
if [ -d .github/workflows ]; then
  grep -rl 'auto-changelog\|conventional-changelog\|git-cliff\|release-please' .github/workflows/ 2>/dev/null | head -3
fi

echo ""
echo "-- Управление устаревшими issue --"
if [ -d .github/workflows ]; then
  grep -rl 'stale' .github/workflows/ 2>/dev/null | while read f; do
    echo "  $(basename "$f")"
  done
fi
[ -f .github/stale.yml ] && echo ".github/stale.yml"

echo ""
echo "-- Автоматизация меток --"
find . -maxdepth 3 -name 'labeler.yml' -o -name '.github/labeler.yml' -o -name 'label-sync*' 2>/dev/null | sort

echo ""
echo "-- Мультиплатформенный CI --"
if [ -d .github/workflows ]; then
  grep -rl 'matrix:' .github/workflows/ 2>/dev/null | while read f; do
    os_line=$(grep -A5 'matrix:' "$f" | grep -i 'os:' | head -1)
    [ -n "$os_line" ] && echo "  $(basename "$f"): $os_line"
  done
fi

echo ""
echo "-- Автоматизация деплоя --"
if [ -d .github/workflows ]; then
  grep -ril 'deploy' .github/workflows/ 2>/dev/null | while read f; do
    echo "  $(basename "$f")"
  done
fi
[ -f vercel.json ] && echo "./vercel.json"
[ -f netlify.toml ] && echo "./netlify.toml"
[ -f fly.toml ] && echo "./fly.toml"
[ -f render.yaml ] && echo "./render.yaml"
