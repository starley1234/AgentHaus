# Сопоставление типов данных COBOL → Java

| COBOL | Java | Примечания |
|-------|------|-------|
| `PIC 9(n)V99` | `BigDecimal` | Десятичное с подразумеваемой десятичной точкой |
| `PIC X(n)` | `String` | Буквенно-цифровой |
| `PIC 9(n)` | `int` или `long` | Используйте `long` для n > 9 |
| `COMP-3` (упакованное десятичное) | `BigDecimal` | Сохраняйте точность |
| `OCCURS n TIMES` | `List<T>` или массив | Предпочитайте `List` для гибкости |

## Сопоставление управляющих конструкций

| COBOL | Java |
|-------|------|
| `PERFORM` | вызов метода |
| `EVALUATE/WHEN` | `switch` |
| `IF/ELSE` | `if/else` |
| `PERFORM UNTIL` | цикл `while` |
| `PERFORM VARYING` | цикл `for` |
