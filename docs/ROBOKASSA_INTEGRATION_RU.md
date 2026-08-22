# Robokassa — подключаемое платёжное решение для AgentHaus (RU)

Готовый модуль для приёма платежей в России через Robokassa. Интегрируется в любой сервис AgentHaus (BOM-парсер, микро-SaaS фабрика, SEO сайты, Meeting Notes Pro) за 5 минут.

## Что реализовано

### 1. Библиотека `services/lib/robokassa.mjs`

Основано на официальной документации `docs.robokassa.ru`:

- **URL оплаты:** `https://auth.robokassa.ru/Merchant/Index.aspx`
- **Алгоритмы подписи:** MD5, SHA1, SHA256, SHA384, SHA512, RIPEMD160 (настраивается в ЛК Robokassa → Технические настройки → Алгоритм расчёта хэша)
- **Подпись запроса:** `MerchantLogin:OutSum:InvId:Receipt:Password1:Shp_...` → hash
- **Подпись ResultURL:** `OutSum:InvId:Password2:Shp_...` → hash, сервер Robokassa должен получить `OK{InvId}`
- **Подпись SuccessURL:** `OutSum:InvId:Password1:Shp_...`
- **Shp_ параметры:** пользовательские данные (`Shp_userId`, `Shp_service`, `Shp_credits`), сортируются по алфавиту, формат `:Shp_key=value`

**Класс `Robokassa`:**
```js
import { Robokassa } from "../lib/robokassa.mjs";

const rk = new Robokassa({
  merchantLogin: "your_login",
  password1: "pass1",
  password2: "pass2",
  isTest: true,
  algorithm: "md5" // должен совпадать с ЛК
});

// Создание ссылки
const url = rk.generatePaymentUrl({
  outSum: 500.00,
  invId: 12345,
  description: "BOM-парсер 50 страниц",
  receipt: { items: [{ name: "BOM", quantity: 1, sum: 500, tax: "none" }] },
  userParams: { Shp_userId: "123", Shp_service: "bom-parse", Shp_credits: "2500" },
  email: "test@example.com",
  culture: "ru"
});

// Проверка ResultURL
const valid = rk.validateResult(req.body); // true/false
res.send(rk.getSuccessAnswer(invId)); // OK123

// Проверка SuccessURL
const valid2 = rk.validateSuccess(req.query);
```

### 2. Библиотека `services/lib/billing.mjs` — универсальный биллинг

Обёртка над Robokassa + кредиты:

```js
import { Billing } from "../lib/billing.mjs";

const billing = new Billing({
  serviceName: "bom-parse",
  pricePerUnit: 0.20, // €0.20 per page
  creditsFile: "./credits.json"
});

// Проверка баланса
await billing.hasCredits(userId, pages);

// Списание
await billing.deductCredits(userId, pages);

// Создание платежа Robokassa для пополнения
const payment = billing.createRobokassaPayment({
  amount: 500,
  description: "Пополнение BOM-парсера",
  userId: "123",
  email: "test@example.com"
});
// → { invId, amount, paymentUrl, credits, isTest, merchantLogin }

// Обработка ResultURL — авто-начисление кредитов
const result = await billing.handleRobokassaResult(req.body);
// → { valid, invId, userId, creditsAdded, newBalance }
```

Хранилище кредитов — `credits.json` (в проде заменить на SQLite/Postgres):
```json
{
  "total": 100,
  "users": { "123": 50, "456": 20 },
  "updated": "2026-08-22T..."
}
```

### 3. Сервис `services/robokassa-payment/` — демо и шлюз

Демонстрационный сервис на порту `.../robokassa-payment/`:

**Endpoints:**
- `GET /health` — проверка
- `GET /api/config` — текущая конфигурация (merchantLogin, isTest, price, result/success/fail URLs)
- `POST /api/create-payment` — создать платёж: `{ outSum, description, email, userParams }` → `{ invId, paymentUrl }`
- `GET /api/orders` — список заказов, `?id=123` — конкретный
- `POST /api/robokassa/result` — **ResultURL**, вызывается сервером Robokassa, проверяет подпись по Password2, начисляет кредиты, возвращает `OK{InvId}`
- `GET /api/robokassa/success` — SuccessURL, куда попадает пользователь после оплаты, показывает "Оплата успешна"
- `GET /api/robokassa/fail` — FailURL

**Web UI** (`web/index.html`):
- Форма создания платежа (сумма, описание, email, Shp_userId, Shp_service)
- Кнопка "Создать ссылку" → показывает ссылку `💳 Оплатить через Robokassa →`
- Список заказов с статусами pending/paid
- Инструкция подключения и пример кода для любого сервиса
- Конфигурация из env

### 4. Интеграция в `services/bom-parse/` — пример коммерциализации

BOM-парсер теперь:

- `POST /api/create-payment` — создать Robokassa ссылку для пополнения кредитов: `{ amount: 500, userId: "123" }` → `paymentUrl` + `credits: 2500` (при €0.20/page)
- `POST /api/robokassa/result` — без x-api-key, с проверкой подписи, начисляет кредиты через `billing.handleRobokassaResult`, возвращает `OK{InvId}`
- `GET /api/robokassa/success` / `fail` — страницы для пользователя
- `GET /api/credits` — баланс + настройки Robokassa
- `POST /api/run` — теперь проверяет кредиты `billing.hasCredits(userId, pages)` и списывает `deductCredits`, иначе 402 с предложением пополнить через Robokassa

**Флоу для клиента:**
1. Заходит на `/bom-parse/` → видит "Недостаточно кредитов"
2. Жмёт "Пополнить" → вводит сумму 500 руб → получает ссылку Robokassa
3. Оплачивает → Robokassa вызывает `ResultURL` → кредиты начисляются
4. Загружает PDF → получает JSON/CSV/XLSX

---

## Настройка Robokassa в личном кабинете

1. Регистрация на https://robokassa.ru → Создать магазин
2. **Технические настройки:**
   - Алгоритм расчёта хэша: `MD5` (или SHA256 — должен совпадать с кодом)
   - ResultURL: `https://твой-домен/robokassa-payment/api/robokassa/result` (или `/bom-parse/api/robokassa/result`), метод `POST`
   - SuccessURL: `https://твой-домен/robokassa-payment/api/robokassa/success`, метод `GET`
   - FailURL: `https://твой-домен/robokassa-payment/api/robokassa/fail`, метод `GET`
   - Пароль #1 и #2 — сгенерировать, сохранить (минимум 8 символов, буква+цифра), должны отличаться от пароля ЛК
3. **В .env AgentHaus:**
```env
ROBOKASSA_MERCHANT_LOGIN=твой_логин
ROBOKASSA_PASSWORD1=пароль1_из_ЛК
ROBOKASSA_PASSWORD2=пароль2_из_ЛК
ROBOKASSA_IS_TEST=true
ROBOKASSA_ALGORITHM=md5
BOM_PRICE_PER_PAGE=0.20
```
4. **Тестовый режим:** включи в ЛК, используй тестовые карты из docs.robokassa.ru
5. **Боевой:** после теста запроси активацию магазина (кнопка в ЛК), укажи URL главной страницы с описанием товаров

**Важно:**
- ResultURL должен быть доступен из интернета (не localhost), возвращать `OK{InvId}`, иначе Robokassa считает уведомление недоставленным
- IP Robokassa для белого списка: `185.59.216.65`, `185.59.217.65`
- Сумма `OutSum` в запросе — 2 знака, в ResultURL — 6 знаков (особенность тестовой среды)
- Кодировка всегда UTF-8

---

## Как подключить в свой сервис за 5 минут

Скопируй `services/lib/robokassa.mjs` и `billing.mjs` в свой проект, затем:

```js
// server.mjs
import { Billing } from "../lib/billing.mjs";

const billing = new Billing({ serviceName: "my-service", pricePerUnit: 1 });

app.post("/api/create-payment", (req, res) => {
  const payment = billing.createRobokassaPayment({
    amount: req.body.amount,
    description: "Мой товар",
    userId: req.body.userId,
    email: req.body.email
  });
  res.json(payment);
});

app.post("/api/robokassa/result", async (req, res) => {
  const result = await billing.handleRobokassaResult(req.body);
  if (!result.valid) return res.status(400).send("Invalid");
  // выдать товар
  res.send(billing.getSuccessAnswer(result.invId));
});
```

В `config.json` добавь:
```json
{
  "robokassa": {
    "merchantLogin": "demo",
    "password1": "password_1",
    "password2": "password_2",
    "isTest": true,
    "algorithm": "md5"
  }
}
```

---

## Что дальше (для прода)

- Заменить `credits.json` на SQLite/Postgres с таблицами `users`, `orders`, `credits`
- Добавить в `gateway.mjs` централизованный биллинг middleware для всех сервисов
- Добавить админку для просмотра платежей, возвратов, статистики
- Добавить фискализацию ФЗ-54 через `Receipt` (уже есть `Robokassa.createReceipt`)
- Добавить подписки через `Recurring` флаг и `Token` для сохранённых карт

Все файлы уже в репозитории, готовы к использованию.
