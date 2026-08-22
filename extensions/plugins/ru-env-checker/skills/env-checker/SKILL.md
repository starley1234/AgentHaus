---
name: env-checker
description: Проверка .env и окружения — сравнение с .env.example, поиск секретов, безопасность.
license: MIT
compatibility: Требуется bash, grep, rg
triggers:
  - env
  - .env
  - окружение
  - переменные окружения
  - секреты
  - dotenv
---

# Проверка окружения (RU)

Ты — помощник по проверке окружения и безопасности секретов.

## Что делать

### 1. Найти все .env файлы
```bash
find . -maxdepth 3 -name ".env*" -type f | sort
cat .env.example 2>/dev/null | head -n 100
```

### 2. Сравнить .env с .env.example
- Какие ключи есть в example, но нет в .env (отсутствуют)?
- Какие ключи есть в .env, но нет в example (лишние/устаревшие)?
- Какие значения пустые?

### 3. Проверить безопасность
```bash
# .env в .gitignore?
grep -q "\.env" .gitignore && echo "OK: .env в .gitignore" || echo "ВНИМАНИЕ: .env НЕ в .gitignore!"

# Права файла
ls -l .env .env.example 2>/dev/null

# Поиск секретов в коде (исключая .env, node_modules, dist)
grep -R "API_KEY\s*=\s*['\"][^'\"]\+['\"]" --include="*.ts" --include="*.js" --include="*.py" . 2>/dev/null | grep -v ".env" | head -n 20
```

### 4. Валидация значений
- URL валидны? (`http://`, `https://`)
- Порты в диапазоне 1-65535?
- Булевы значения `true/false`?

### 5. Генерация .env.example
Если просят сгенерировать:
```bash
# Маскировать значения
sed 's/=.*/=/' .env > .env.example.new
```

## Вывод

Сформируй отчёт на русском:
```
## Отчёт проверки окружения

### Найденные .env файлы
- .env (12 переменных)
- .env.example (15 переменных)

### Отсутствуют в .env (есть в example)
- LLM_API_KEY
- ADMIN_KEY

### Проблемы безопасности
- ⚠️ .env не в .gitignore
- 🔴 Найден захардкоженный SECRET в src/config.ts:15

### Рекомендации
1. Добавить .env в .gitignore
2. Заполнить отсутствующие переменные
```

## Безопасность

- **Никогда не выводи реальные значения секретов** — маскируй как `***`
- **Не коммить .env** — только .env.example
