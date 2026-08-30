#!/usr/bin/env python3
"""captcha_playbook.py — справка по прохождению CAPTCHA для агента.

Zero-dependency (stdlib). Это не «обход» капчи, а аккуратный пользовательский
сценарий: агент должен вести себя как человек, использовать браузерные
инструменты и при повторных/сложных задачах спрашивать владельца.

Примеры:
  python3 captcha_playbook.py --list
  python3 captcha_playbook.py recaptcha_image
  python3 captcha_playbook.py --self-check

Типы: recaptcha_checkbox, recaptcha_image, hcaptcha_image, text, sliding,
math, cloudflare_turnstile, unknown, escalate.
"""

import argparse
import sys

PLAYBOOK: dict[str, dict[str, str]] = {
    "recaptcha_checkbox": {
        "title": "reCAPTCHA v2 — галочка «Я не робот»",
        "detect": "Квадрат с галочкой, обычно внутри iframe (src содержит recaptcha).",
        "steps": (
            "1. browser_get_state --include_screenshot — увидь страницу и элементы.\n"
            "2. Найди в выводе index галочки/iframe (tag iframe, text/placeholder пустые).\n"
            "3. Если index есть — browser_click <index>. Если нет — найди "
            "center_x/center_y и browser_move_mouse x y → короткая пауза → "
            "browser_click_coordinates x y.\n"
            "4. Подожди 3–5 секунд (можно browser_get_state снова).\n"
            "5. Проверь: появился ли следующий экран (картинки/кнопка «Проверить») "
            "или галочка зелёная. Если появился новый интерфейс — переходи к "
            "соответствующему виду капчи (recaptcha_image и т.п.)."
        ),
    },
    "recaptcha_image": {
        "title": "reCAPTCHA v2 — картинки (светофоры, переходы, автобусы и т.п.)",
        "detect": "После галочки появляется сетка из 9 изображений и задание сверху.",
        "steps": (
            "1. browser_get_state --include_screenshot — получи сетку карточек и "
            "позиции (center_x/center_y/viewport_position).\n"
            "2. Прочитай задание (например «отметьте все светофоры»).\n"
            "3. По скриншоту определи подходящие карточки. Если визуальной модели "
            "не хватает — закрой вкладку и честно скажи владельцу (не тыкай наугад).\n"
            "4. Для каждой подходящей карточки: browser_move_mouse центр → "
            "browser_click_coordinates центр.\n"
            "5. После всех — найди кнопку «Проверить/Подтвердить» и нажми её "
            "(index или координаты).\n"
            "6. Если снова пришла новая сетка — повтори не более 2–3 раз. "
            "После этого остановись и спроси владельца."
        ),
    },
    "hcaptcha_image": {
        "title": "hCaptcha — картинки/рамки",
        "detect": "Логотип hCaptcha, сетка изображений или выбор рамки.",
        "steps": (
            "1. browser_get_state --include_screenshot.\n"
            "2. Прочитай инструкцию и выдели нужные объекты.\n"
            "3. Используй browser_click_coordinates по center_x/center_y, "
            "перед каждой наводкой browser_move_mouse.\n"
            "4. Подтверди, дождись нового состояния, максимум 2–3 попытки.\n"
            "5. При неудаче — эскалация владельцу."
        ),
    },
    "text": {
        "title": "Текстовая капча (искажённые буквы/цифры)",
        "detect": "Изображение с искажённым текстом + поле ввода.",
        "steps": (
            "1. browser_get_state --include_screenshot.\n"
            "2. Рассмотри изображение (визуальная модель).\n"
            "3. Введи распознанный текст через browser_type в поле ввода.\n"
            "4. Нажми кнопку подтверждения (index или координаты).\n"
            "5. Одна попытка распознавания; при ошибке — повтори не более одного "
            "раза, затем обратись к владельцу."
        ),
    },
    "sliding": {
        "title": "Слайдер / puzzle (перетащить ползунок)",
        "detect": "Ползунок, который нужно протащить по рельсе/картинке.",
        "steps": (
            "1. browser_get_state --include_screenshot.\n"
            "2. Оцени состояние: в текущем браузерном тулсете нет надёжной "
            "«перетаскивания» (drag) — попробуй browser_move_mouse + "
            "browser_click_coordinates для стандартного клика через ползунок.\n"
            "3. Если сайт требует именно drag — НЕ пытайся имитировать наугад: "
            "остановись и попроси владельца пройти вручную/включить VNC."
        ),
    },
    "math": {
        "title": "Математическая капча",
        "detect": "Вопрос вида «2 + 3 = ?»",
        "steps": (
            "1. Прочитай (или распознай с картинки) выражение и сосчитай.\n"
            "2. browser_type в поле ответа → нажми подтверждение.\n"
            "3. Ошибок не больше одной."
        ),
    },
    "cloudflare_turnstile": {
        "title": "Cloudflare Turnstile / WAF-проверка",
        "detect": "Иконка Turnstile, «Verify you are human», загрузка без видимой капчи.",
        "steps": (
            "1. browser_get_state --include_screenshot.\n"
            "2. Дай системе 3–5 секунд (Turnstile часто решается сам).\n"
            "3. Если появился кликабельный виджет — browser_click по нему.\n"
            "4. Учитывай: повторный запрос после 2–3 неудач лучше прекратить и "
            "спросить владельца; не обходи WAF скриптами/прокси без явного запроса."
        ),
    },
    "unknown": {
        "title": "Незнакомая капча",
        "detect": "Не удалось определить тип.",
        "steps": (
            "1. Сделай скриншот (browser_get_state --include_screenshot) и опиши: "
            "iframe? картинки? ползунок? question? Ссылку/домен.\n"
            "2. Попробуй только безопасные действия: нажать «Проверить», подождать, "
            "обновить состояние один раз.\n"
            "3. Не рандомь клики и не вводи бессмысленные ответы.\n"
            "4. Если не получается — escalate."
        ),
    },
    "escalate": {
        "title": "Эскалация владельцу",
        "detect": "Повторная капча / не получается / сайт требует человеческую личность.",
        "steps": (
            "1. Прекрати попытки (2–3 максимум).\n"
            "2. Сообщи владельцу: домен, что видишь (скриншот/описание), что уже "
            "пробовал, какие данные/разрешения нужны.\n"
            "3. Можешь предложить: пройти вручную, включить VNC (OH_ENABLE_VNC=true), "
            "или использовать официальное API/безкапчевый вход.\n"
            "4. Не проси и не используй чужие/массовые решатели капчи для "
            "автоматического обхода — это нарушает ToS и часто приводит к блокировке.",
        ),
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "type",
        nargs="?",
        default=None,
        help="тип капчи (см. --list), например recaptcha_image",
    )
    parser.add_argument(
        "--list", action="store_true", help="показать список типов и названия"
    )
    parser.add_argument(
        "--self-check", action="store_true", help="вывести универсальный порядок действий"
    )
    args = parser.parse_args()

    if args.list:
        print("Типы CAPTCHA:")
        for key, value in PLAYBOOK.items():
            print(f"  {key:22} — {value['title']}")
        return 0

    if args.self_check:
        print("Универсальный порядок:")
        for key, value in PLAYBOOK.items():
            print(f"[{key}] {value['title']}")
        print(
            "\nЕсли тип неизвестен: сделай browser_get_state --include_screenshot,"
            " опиши, что видишь, и обратись к владельцу после 2–3 неудач."
        )
        return 0

    if args.type is None:
        parser.print_help()
        return 2

    key = args.type.strip().lower()
    if key not in PLAYBOOK:
        print(f"Неизвестный тип: {key}", file=sys.stderr)
        print("Запусти с --list для списка.", file=sys.stderr)
        return 1

    value = PLAYBOOK[key]
    print(f"## {value['title']}")
    print(f"Как распознать: {value['detect']}")
    print("\nДействия:\n" + value["steps"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
