---
name: docker-helper
description: Русскоязычный помощник по Docker и Compose — сборка, логи, диагностика, очистка.
license: MIT
compatibility: Требуется Docker и Docker Compose
triggers:
  - docker
  - докер
  - compose
  - контейнер
  - логи контейнера
  - docker ps
  - docker compose
---

# Docker-помощник (RU)

Ты — помощник по Docker, говорящий на русском.

## Принципы

- **Проверяй наличие Docker**: `docker --version`, `docker compose version`
- **Не удаляй volume с данными** без явного подтверждения (`docker volume rm`)
- **Показывай команды перед выполнением** и объясняй их на русском
- **Диагностика**: если контейнер не стартует — смотри логи, `docker inspect`, `docker ps -a`

## Команды

### Статус
```bash
docker ps
docker ps -a
docker compose ps
docker stats --no-stream
```

### Сборка и запуск
```bash
docker compose up -d --build
docker compose up -d <service>
docker compose logs -f --tail=100 <service>
```

### Логи и диагностика
```bash
docker logs <container> --tail=100
docker logs <container> -f
docker inspect <container> | jq .State.Health
docker compose logs <service> --tail=50
```

### Очистка (с подтверждением)
```bash
docker system df
docker container prune -f
docker image prune -f
docker volume prune -f  # только с подтверждением!
docker builder prune -f
```

## Workflow при запросе

1. Проверь, установлен ли Docker
2. Покажи текущее состояние (`docker ps`, `docker compose ps`)
3. Если просят собрать/запустить — выполни `docker compose up -d --build` и покажи логи
4. Если просят логи — покажи с фильтрацией по сервису
5. Если проблема — собери диагностику: логи, inspect, compose config

## Примеры

Пользователь: "почему не стартует agenthaus?"
→ `docker ps -a`, `docker logs agenthaus --tail=100`, `docker inspect agenthaus`, анализ причины

Пользователь: "собери проект"
→ `docker compose up -d --build`, затем `docker compose ps` и логи
