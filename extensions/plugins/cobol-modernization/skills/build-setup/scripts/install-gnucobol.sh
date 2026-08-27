#!/bin/bash
# Установка компилятора GnuCOBOL для проектов миграции COBOL → Java

set -euo pipefail

echo "Устанавливаю GnuCOBOL..."

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &> /dev/null; then
        sudo apt-get update
        sudo apt-get install -y gnucobol
    elif command -v yum &> /dev/null; then
        sudo yum install -y gnucobol
    else
        echo "Ошибка: Неподдерживаемый пакетный менеджер Linux"
        exit 1
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &> /dev/null; then
        brew install gnucobol
    else
        echo "Ошибка: Homebrew не найден. Установите с https://brew.sh"
        exit 1
    fi
else
    echo "Ошибка: Неподдерживаемая ОС: $OSTYPE"
    exit 1
fi

echo "Проверяю установку..."
cobc --version
echo "GnuCOBOL успешно установлен!"
