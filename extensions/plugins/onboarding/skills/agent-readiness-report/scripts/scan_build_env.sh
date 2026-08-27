#!/usr/bin/env bash
# Сканирование сигналов Сборки и окружения разработки (Столп 5)

REPO="${1:-.}"
cd "$REPO" 2>/dev/null || { echo "Не могу получить доступ к $REPO"; exit 1; }

echo "=== Столп 5: Сборка и окружение разработки ==="
echo ""

echo "-- Лок-файлы зависимостей --"
for f in package-lock.json yarn.lock pnpm-lock.yaml bun.lockb \
         Cargo.lock go.sum Gemfile.lock poetry.lock uv.lock \
         Pipfile.lock composer.lock pubspec.lock; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Команды сборки --"
for f in README.md AGENTS.md CONTRIBUTING.md Makefile Justfile; do
  if [ -f "$f" ]; then
    build_refs=$(grep -ci 'make build\|npm run build\|cargo build\|go build\|gradle build\|mvn.*package\|bundle exec' "$f" 2>/dev/null)
    [ "$build_refs" -gt 0 ] && echo "  $build_refs ссылок на команды сборки в $f"
  fi
done

echo ""
echo "-- Скрипты настройки --"
for f in bin/setup script/setup scripts/setup.sh scripts/bootstrap.sh \
         script/bootstrap Makefile Justfile; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Dev-контейнер --"
if [ -d .devcontainer ]; then
  echo ".devcontainer/:"
  ls -1 .devcontainer/ 2>/dev/null | while read f; do echo "  $f"; done
elif [ -f devcontainer.json ]; then
  echo "./devcontainer.json"
else
  echo "  (не найдено)"
fi

echo ""
echo "-- Контейнеризованные сервисы --"
find . -maxdepth 2 -name 'Dockerfile*' -o -name 'docker-compose*.yml' \
  -o -name 'docker-compose*.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' 2>/dev/null | sort

echo ""
echo "-- Воспроизводимое окружение --"
for f in flake.nix shell.nix default.nix devbox.json devbox.lock; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Фиксация версий инструментов --"
for f in .tool-versions mise.toml .mise.toml .node-version .nvmrc \
         .python-version .ruby-version .go-version rust-toolchain.toml \
         rust-toolchain .java-version .sdkmanrc; do
  [ -f "$f" ] && echo "./$f"
done

echo ""
echo "-- Оркестрация монорепозитория --"
if [ -f package.json ]; then
  grep -q '"workspaces"' package.json 2>/dev/null && echo "  workspaces в package.json"
fi
for f in pnpm-workspace.yaml lerna.json nx.json turbo.json rush.json; do
  [ -f "$f" ] && echo "./$f"
done
if [ -f Cargo.toml ]; then
  grep -q '\[workspace\]' Cargo.toml 2>/dev/null && echo "  Cargo workspace в Cargo.toml"
fi
if [ -f go.work ]; then
  echo "./go.work"
fi

echo ""
echo "-- Кэширование сборки --"
if [ -d .github/workflows ]; then
  cache_count=$(grep -rl 'actions/cache\|buildx.*cache\|turbo.*cache\|ccache\|sccache' .github/workflows/ 2>/dev/null | wc -l | tr -d ' ')
  echo "  $cache_count workflow с конфигурацией кэша"
fi
[ -f turbo.json ] && grep -q 'cache' turbo.json 2>/dev/null && echo "  Конфиг кэша Turborepo"

echo ""
echo "-- Кроссплатформенная поддержка --"
if [ -d .github/workflows ]; then
  for f in .github/workflows/*.yml .github/workflows/*.yaml; do
    [ -f "$f" ] || continue
    if grep -q 'matrix:' "$f" 2>/dev/null; then
      os_line=$(grep -A10 'matrix:' "$f" | grep -i 'os:' | head -1 | tr -d ' ')
      [ -n "$os_line" ] && echo "  $(basename "$f"): $os_line"
    fi
  done
fi

echo ""
echo "-- Облачное dev-окружение --"
[ -f .gitpod.yml ] && echo "./.gitpod.yml"
if [ -d .devcontainer ]; then
  grep -q 'codespaces\|ghcr.io' .devcontainer/devcontainer.json 2>/dev/null \
    && echo "  Поддержка Codespaces в devcontainer.json"
fi

echo ""
echo "-- Конфигурация пакетного менеджера --"
for f in .npmrc .yarnrc .yarnrc.yml .pnpmrc pip.conf .cargo/config.toml \
         .cargo/config gradle.properties; do
  [ -f "$f" ] && echo "./$f"
done
