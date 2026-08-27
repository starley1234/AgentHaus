#!/usr/bin/env bash
# Сканирование сигналов Петель обратной связи (Столп 2)

REPO="${1:-.}"
cd "$REPO" 2>/dev/null || { echo "Не могу получить доступ к $REPO"; exit 1; }

echo "=== Столп 2: Петли обратной связи ==="
echo ""

echo "-- Конфигурация линтера --"
find . -maxdepth 2 \( \
  -name '.eslintrc*' -o -name 'eslint.config.*' \
  -o -name 'ruff.toml' -o -name '.golangci.yml' -o -name '.golangci.yaml' \
  -o -name 'clippy.toml' -o -name '.clippy.toml' \
  -o -name '.pylintrc' -o -name 'pylintrc' \
  -o -name 'biome.json' -o -name 'biome.jsonc' \
  -o -name '.swiftlint.yml' -o -name '.ktlint*' \
  \) 2>/dev/null | sort
if [ -f pyproject.toml ]; then
  grep -l -i '\[tool\.ruff\]\|\[tool\.pylint\]\|\[tool\.flake8\]' pyproject.toml 2>/dev/null \
    && echo "  (также: конфиг линтера в pyproject.toml)"
fi

echo ""
echo "-- Конфигурация форматтера --"
find . -maxdepth 2 \( \
  -name '.prettierrc*' -o -name 'prettier.config.*' \
  -o -name 'rustfmt.toml' -o -name '.rustfmt.toml' \
  -o -name '.clang-format' \
  -o -name '.editorconfig' \
  \) 2>/dev/null | sort
if [ -f pyproject.toml ]; then
  grep -l -i '\[tool\.black\]\|\[tool\.ruff\.format\]\|\[tool\.isort\]' pyproject.toml 2>/dev/null \
    && echo "  (также: конфиг форматтера в pyproject.toml)"
fi

echo ""
echo "-- Проверка типов --"
find . -maxdepth 2 -name 'tsconfig.json' -o -name 'tsconfig.*.json' 2>/dev/null | sort
if [ -f tsconfig.json ]; then
  grep -q '"strict"' tsconfig.json 2>/dev/null && echo "  (strict режим в tsconfig.json)"
fi
find . -maxdepth 2 -name 'mypy.ini' -o -name '.mypy.ini' 2>/dev/null | sort
if [ -f pyproject.toml ]; then
  grep -q '\[tool\.mypy\]\|\[tool\.pyright\]' pyproject.toml 2>/dev/null \
    && echo "  (конфиг проверки типов в pyproject.toml)"
fi
find . -maxdepth 1 -name 'py.typed' 2>/dev/null

echo ""
echo "-- Pre-commit хуки --"
for f in .pre-commit-config.yaml .husky lefthook.yml .lefthook.yml; do
  [ -e "$f" ] && echo "./$f"
done
if [ -f package.json ]; then
  grep -q 'lint-staged' package.json 2>/dev/null && echo "  (lint-staged в package.json)"
fi

echo ""
echo "-- Каталоги тестов --"
for d in test tests __tests__ spec test/unit test/integration tests/unit tests/integration \
         test/e2e tests/e2e e2e cypress playwright; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -maxdepth 1 -type f | wc -l | tr -d ' ') файлов верхнего уровня)"
done

echo ""
echo "-- Количество тестовых файлов --"
test_files=$(find . -maxdepth 5 \( \
  -name '*_test.go' -o -name '*_test.py' -o -name 'test_*.py' \
  -o -name '*.spec.ts' -o -name '*.test.ts' -o -name '*.spec.js' -o -name '*.test.js' \
  -o -name '*_test.rb' -o -name '*_spec.rb' \
  -o -name '*_test.rs' \
  \) 2>/dev/null | wc -l | tr -d ' ')
echo "  $test_files тестовых файлов найдено"

echo ""
echo "-- Измерение покрытия тестами --"
find . -maxdepth 2 -name '.codecov.yml' -o -name 'codecov.yml' 2>/dev/null | sort
if [ -f package.json ]; then
  grep -q 'coverageThreshold\|collectCoverage' package.json 2>/dev/null && echo "  покрытие в package.json"
fi
if [ -f pyproject.toml ]; then
  grep -q '\[tool\.coverage\]\|\[tool\.pytest.*cov' pyproject.toml 2>/dev/null && echo "  покрытие в pyproject.toml"
fi

echo ""
echo "-- CI-пайплайн --"
if [ -d .github/workflows ]; then
  echo ".github/workflows/:"
  ls -1 .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null | while read f; do
    echo "  $(basename "$f")"
  done
fi
for f in .circleci/config.yml .gitlab-ci.yml Jenkinsfile .travis.yml; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Валидация конфигов/схем --"
find . -maxdepth 2 -name '.yamllint*' -o -name 'taplo.toml' 2>/dev/null | sort
if [ -d .github/workflows ]; then
  grep -rl 'actionlint\|yamllint\|schema.*validate' .github/workflows/ 2>/dev/null | head -3
fi

echo ""
echo "-- Снапшот-тесты --"
snap_count=$(find . -maxdepth 5 -name '__snapshots__' -o -name '*.snap' 2>/dev/null | wc -l | tr -d ' ')
golden_count=$(find . -maxdepth 4 -name 'testdata' -type d 2>/dev/null | wc -l | tr -d ' ')
echo "  $snap_count снапшот каталогов/файлов, $golden_count каталогов testdata"

echo ""
echo "-- Набор бенчмарков --"
for d in bench benchmarks benchmark; do
  [ -d "$d" ] && echo "./$d/ ($(find "$d" -type f | wc -l | tr -d ' ') файлов)"
done
bench_files=$(find . -maxdepth 4 -name '*_bench_test.go' -o -name '*benchmark*' -type f 2>/dev/null | wc -l | tr -d ' ')
echo "  $bench_files файлов бенчмарков найдено"

echo ""
echo "-- Проверка орфографии --"
find . -maxdepth 2 -name '.cspell.json' -o -name 'cspell.json' -o -name 'typos.toml' \
  -o -name '.typos.toml' 2>/dev/null | sort
if [ -f .pre-commit-config.yaml ]; then
  grep -q 'codespell\|cspell\|typos' .pre-commit-config.yaml 2>/dev/null \
    && echo "  (проверка орфографии в pre-commit конфиге)"
fi
