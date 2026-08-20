---
name: kubernetes
description: Настройка и управление локальными Kubernetes-кластерами с помощью KIND (Kubernetes IN Docker). Используй при локальном тестировании Kubernetes-приложений или разработке cloud-native рабочих нагрузок.
triggers:
- kubernetes
- k8s
- kube
---

# Локальная разработка Kubernetes с KIND

## Установка и настройка KIND

KIND (Kubernetes IN Docker) — это инструмент для запуска локальных Kubernetes-кластеров, использующий Docker-контейнеры в качестве узлов. Он предназначен для локального тестирования Kubernetes-приложений.

ВАЖНО: Прежде чем приступать к установке, убедись, что docker установлен локально.
Эквиваленты для Windows PowerShell по установке KIND и kubectl находятся в `references/windows.md`.

### Установка

Для установки KIND на систему Debian/Ubuntu:

```bash
# Скачать бинарник KIND
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.22.0/kind-linux-amd64
# Сделать его исполняемым
chmod +x ./kind
# Переместить в каталог из PATH
sudo mv ./kind /usr/local/bin/
```

Для установки kubectl:

```bash
# Скачать kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
# Сделать его исполняемым
chmod +x kubectl
# Переместить в каталог из PATH
sudo mv ./kubectl /usr/local/bin/
```

### Создание кластера

Создай базовый KIND-кластер:

```bash
kind create cluster
```
