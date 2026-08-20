---
name: swift-linux
description: Установка и настройка языка программирования Swift на Debian Linux для серверной разработки. Используй при сборке Swift-приложений на Linux или настройке окружения разработки Swift.
triggers:
- swift-linux
- swift-debian
- swift-installation
---

# Руководство по установке Swift для Debian Linux

Этот документ содержит инструкции по установке Swift на Debian 12 (Bookworm).

> Эта настройка предназначена для задач разработки без UI на Swift под Linux.
> На Windows выполняй эти команды Debian внутри WSL2 или Linux-контейнера. Для нативного Windows Swift используй Windows-тулчейн со Swift.org.

## Предварительные требования

Перед установкой Swift нужно установить требуемые зависимости для твоей системы. Актуальный список зависимостей для твоей конкретной дистрибуции Linux и версии можно найти в [руководстве по установке из tarball на Swift.org](https://www.swift.org/install/linux/tarball/).

НАПРИМЕР, зависимости, которые могут понадобиться для Debian 12:

```bash
sudo apt-get update
sudo apt-get install -y \
  binutils-gold \
  gcc \
  git \
  libcurl4-openssl-dev \
  libedit-dev \
  libicu-dev \
  libncurses-dev \
  libpython3-dev \
  libsqlite3-dev \
  libxml2-dev \
  pkg-config \
  tzdata \
  uuid-dev
```

## Скачивание и установка Swift

1. Найди последнюю версию Swift для Debian:

   Перейди на [страницу загрузки Swift.org](https://www.swift.org/download/), чтобы найти последнюю версию Swift, совместимую с Debian 12 (Bookworm).

   Ищи tarball с именем вроде `swift-<VERSION>-RELEASE-debian12.tar.gz` (например, `swift-6.0.3-RELEASE-debian12.tar.gz`).

   Шаблон URL обычно такой:
   ```
   https://download.swift.org/swift-<VERSION>-release/debian12/swift-<VERSION>-RELEASE/swift-<VERSION>-RELEASE-debian12.tar.gz
   ```

   Где `<VERSION>` — номер версии Swift (например, `6.0.3`).

2. Скачай бинарник Swift для Debian 12:

```bash
cd /workspace
wget https://download.swift.org/swift-6.0.3-release/debian12/swift-6.0.3-RELEASE/swift-6.0.3-RELEASE-debian12.tar.gz
```

3. Распакуй архив:

> **Примечание**: Установи Swift в каталог `/workspace`, но вне git-репозитория, чтобы не коммитить бинарники Swift.

4. Добавь Swift в PATH, добавив следующую строку в файл `~/.bashrc`:

```bash
echo 'export PATH=/workspace/swift-6.0.3-RELEASE-debian12/usr/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

> **Примечание**: Обязательно обнови номер версии в PATH, чтобы он соответствовал скачанной версии.

## Проверка установки

Проверь, что Swift установлен корректно, выполнив:

```bash
swift --version
```
