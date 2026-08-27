#!/bin/bash
# OpenHands Cloud — установка CLI, аутентификация, отправка задачи, открытие URL беседы
# Использование: run.sh "ваше сообщение здесь"
# Коды выхода: 0 = успех, 1 = ошибка, 2 = требуется аутентификация (повторно запустите после аутентификации пользователя)

set -o pipefail

MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
    echo "ОШИБКА: Сообщение не предоставлено"
    echo "Использование: run.sh \"ваше сообщение здесь\""
    exit 1
fi

# Шаг 1: Убедиться, что OpenHands CLI установлен
if ! command -v openhands &> /dev/null; then
    echo "OpenHands CLI не найден. Устанавливаю..."
    uv tool install openhands --python 3.12
    if [ $? -ne 0 ]; then
        echo "ОШИБКА: Не удалось установить OpenHands CLI"
        exit 1
    fi
    echo "OpenHands CLI успешно установлен."

    # Свежая установка — запуск потока аутентификации
    echo ""
    echo "Требуется аутентификация. Запускаю аутентификацию OpenHands Cloud..."
    openhands cloud
    echo ""
    echo "AUTH_REQUIRED: Пожалуйста, подтвердите, что вы прошли аутентификацию, затем этот скрипт будет перезапущен."
    exit 2
fi

# Шаг 2: Отправка задачи
echo "Отправка задачи в OpenHands Cloud..."
OUTPUT=$(openhands cloud -t "$MESSAGE" 2>&1)
EXIT_CODE=$?

# Проверка на сбои аутентификации
if [ $EXIT_CODE -ne 0 ] || echo "$OUTPUT" | grep -qi "auth\|login\|unauthorized\|token"; then
    if echo "$OUTPUT" | grep -qi "auth\|login\|unauthorized\|token\|credential"; then
        echo "Требуется аутентификация. Запускаю аутентификацию OpenHands Cloud..."
        openhands cloud
        echo ""
        echo "AUTH_REQUIRED: Пожалуйста, подтвердите, что вы прошли аутентификацию, затем этот скрипт будет перезапущен."
        exit 2
    else
        echo "ОШИБКА: Команда завершилась неудачей"
        echo "$OUTPUT"
        exit 1
    fi
fi

# Шаг 3: Извлечь URL и открыть в браузере
echo "$OUTPUT"

URL=$(echo "$OUTPUT" | grep -oE 'https?://[^[:space:]]+' | head -1 | sed 's/[,;)]$//')

if [ -n "$URL" ]; then
    echo ""
    echo "Открываю $URL в браузере..."
    case "$(uname -s)" in
        Darwin)       open "$URL" ;;
        Linux)        xdg-open "$URL" 2>/dev/null || sensible-browser "$URL" 2>/dev/null || echo "Пожалуйста, откройте URL вручную: $URL" ;;
        MINGW*|CYGWIN*|MSYS*) start "$URL" ;;
        *)            echo "Пожалуйста, откройте URL вручную: $URL" ;;
    esac
fi
