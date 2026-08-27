# Пример трансформации COBOL → Java

## COBOL (До)

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALC-TAX.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-SUBTOTAL    PIC 9(7)V99.
       01 WS-TAX-RATE    PIC V999 VALUE 0.085.
       01 WS-TAX-AMOUNT  PIC 9(7)V99.

       PROCEDURE DIVISION.
           MULTIPLY WS-SUBTOTAL BY WS-TAX-RATE
               GIVING WS-TAX-AMOUNT.
           STOP RUN.
```

## Java (После)

```java
/**
 * Сервис расчёта налогов.
 * Эквивалент COBOL: CALC-TAX.cbl
 */
public class TaxCalculator {
    private static final BigDecimal DEFAULT_TAX_RATE = new BigDecimal("0.085");

    private final BigDecimal taxRate;

    public TaxCalculator() {
        this(DEFAULT_TAX_RATE);
    }

    public TaxCalculator(BigDecimal taxRate) {
        this.taxRate = Objects.requireNonNull(taxRate, "Ставка налога не может быть null");
    }

    /**
     * Рассчитать налог для заданной суммы.
     * Эквивалент COBOL: CALC-TAX.cbl строки 10-12
     *
     * @param subtotal Сумма до налога
     * @return Рассчитанная сумма налога
     * @throws IllegalArgumentException если subtotal null или отрицательный
     */
    public BigDecimal calculateTax(BigDecimal subtotal) {
        if (subtotal == null) {
            throw new IllegalArgumentException("Подытог не может быть null");
        }
        if (subtotal.compareTo(BigDecimal.ZERO) < 0) {
            throw new IllegalArgumentException("Подытог не может быть отрицательным");
        }
        return subtotal.multiply(taxRate).setScale(2, RoundingMode.HALF_UP);
    }
}
```
