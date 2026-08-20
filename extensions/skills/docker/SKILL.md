---
name: docker
description: Выполнение Docker-команд в среде контейнера, включая запуск демона Docker и управление контейнерами. Используй при сборке, запуске или управлении Docker-контейнерами и образами.
triggers:
- docker
- container
---

# Руководство по использованию Docker

## Запуск Docker в контейнерных средах

Проверь, установлен ли docker. Если да, для запуска Docker в контейнерной среде:

```bash
# Запустить демон Docker в фоне
sudo dockerd > /tmp/docker.log 2>&1 &

# Подождать инициализации Docker
sleep 5
```

На Windows запусти Docker Desktop или службу Docker вместо `sudo dockerd`; затем выполняй Docker-команды из PowerShell без `sudo`.

## Проверка установки Docker

Чтобы проверить, что Docker работает корректно, запусти контейнер hello-world:

```bash
sudo docker run hello-world
```

Эквивалент в PowerShell после запуска Docker Desktop: `docker run hello-world`.
