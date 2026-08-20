---
name: spark-version-upgrade
description: Обновление приложений Apache Spark между мажорными версиями (2.x→3.x, 3.x→4.x). Охватывает файлы сборки, устаревшие API, изменения конфигурации, обновления SQL/DataFrame и валидацию тестов.
license: MIT
compatibility: Требуются Java 8+/11+/17+, Scala 2.12/2.13, Maven/Gradle/SBT, Apache Spark
triggers:
  - spark upgrade
  - spark migration
  - spark version
  - upgrade spark
  - spark 3
  - spark 4
  - pyspark upgrade
---

Обнови приложения Apache Spark между мажорными версиями с помощью структурированного, поэтапного рабочего процесса.

## Когда использовать

- Миграция с Spark 2.x → 3.x или Spark 3.x → 4.x
- Обновление приложений PySpark, Spark SQL или Structured Streaming
- Устранение предупреждений об устаревании перед обновлением версии Spark

## Обзор рабочего процесса

1. **Инвентаризация и анализ влияния** — Просканируй кодовую базу и оцени объём
2. **Обновление файлов сборки** — Обнови зависимости Spark/Scala/Java
3. **Миграция API** — Замени устаревшие и удалённые API
4. **Миграция конфигурации** — Обнови свойства конфигурации Spark
5. **Миграция SQL и DataFrame** — Исправь изменения запросов, ломающие совместимость
6. **Валидация тестов** — Скомпилируй, запусти тесты, проверь результаты

---

## Фаза 1: Инвентаризация и анализ влияния

Перед изменением любого кода оцени, что нужно изменить. Прочитай официальное руководство по миграции Apache Spark для целевой версии — в нём документированы каждое удаление API, переименование конфига и изменение поведения по версиям:
https://spark.apache.org/docs/latest/migration-guide.html

### Чек-лист

- [ ] Прочитай раздел руководства по миграции для целевой версии Spark
- [ ] Определи текущую версию Spark (проверь `pom.xml`, `build.sbt`, `build.gradle` или `requirements.txt`)
- [ ] Определи целевую версию Spark
- [ ] Найди устаревшие API: `grep -rn 'import org.apache.spark' --include='*.scala' --include='*.java' --include='*.py'`
- [ ] Перечисли все свойства конфигурации Spark: `grep -rn 'spark\.' --include='*.conf' --include='*.properties' --include='*.scala' --include='*.java' --include='*.py' | grep -v 'test'`
- [ ] В Windows PowerShell используй `Get-ChildItem -Recurse -Include *.scala,*.java,*.py | Select-String 'import org.apache.spark'` и адаптируй расширения/шаблон для поиска конфигов.
- [ ] Проверь кастомные расширения `SparkSession` или `SparkContext`
- [ ] Определи зависимости коннекторов (Hive, Kafka, Cassandra, Delta, Iceberg)
- [ ] Задокументируй находки в `spark_upgrade_impact.md`

### Вывод

```
spark_upgrade_impact.md   # Сводка затронутых файлов, API и конфигов
```

---

## Фаза 2: Обновление файлов сборки

Обнови версии зависимостей и устрани проблемы компиляции.

### Maven (`pom.xml`)

```xml
<!-- Update Spark version property -->
<spark.version>3.5.1</spark.version>    <!-- or 4.0.0 -->
<scala.version>2.13.12</scala.version>  <!-- Spark 3.x: 2.12/2.13; Spark 4.x: 2.13 -->

<!-- Update artifact IDs if Scala cross-version changed -->
<artifactId>spark-core_2.13</artifactId>
<artifactId>spark-sql_2.13</artifactId>
```

### SBT (`build.sbt`)

```scala
val sparkVersion = "3.5.1" // or "4.0.0"
scalaVersion := "2.13.12"

libraryDependencies += "org.apache.spark" %% "spark-core" % sparkVersion
libraryDependencies += "org.apache.spark" %% "spark-sql" % sparkVersion
```

### Gradle (`build.gradle`)

```groovy
ext {
    sparkVersion = '3.5.1' // or '4.0.0'
}
dependencies {
    implementation "org.apache.spark:spark-core_2.13:${sparkVersion}"
    implementation "org.apache.spark:spark-sql_2.13:${sparkVersion}"
}
```

### PySpark (`requirements.txt` / `pyproject.toml`)

```
pyspark==3.5.1   # or 4.0.0
```

### Чек-лист

- [ ] Обнови версию Spark в файле сборки
- [ ] Обнови версию Scala, если переходишь границу 2.12→2.13
- [ ] Обнови уровень source/target Java, если требуется (Spark 4.x требует Java 17+)
- [ ] Обнови версии библиотек коннекторов под новую версию Spark
- [ ] Устрани конфликты зависимостей (`mvn dependency:tree` / `sbt dependencyTree`)
- [ ] Подтверди, что проект компилируется (ошибки на этом этапе ожидаемы — они направляют Фазу 3)

---

## Фаза 3: Миграция API

Замени удалённые и устаревшие API. Прорабатывай ошибки компилятора систематически.

### Частые паттерны

Обратись к официальному руководству по миграции Apache Spark за полным списком изменений для каждой версии:
https://spark.apache.org/docs/latest/migration-guide.html

#### Создание SparkSession (2.x → 3.x)

```scala
// BEFORE (Spark 1.x/2.x)
val sc = new SparkContext(conf)
val sqlContext = new SQLContext(sc)

// AFTER (Spark 2.x+/3.x)
val spark = SparkSession.builder()
  .config(conf)
  .enableHiveSupport() // if needed
  .getOrCreate()
val sc = spark.sparkContext
```

#### RDD в DataFrame (2.x → 3.x)

```scala
// BEFORE
rdd.toDF()  // implicit from SQLContext

// AFTER
import spark.implicits._
rdd.toDF()  // implicit from SparkSession
```

#### API Accumulator (2.x → 3.x)

```scala
// BEFORE
val acc = sc.accumulator(0)

// AFTER
val acc = sc.longAccumulator("name")
```

### Чек-лист

- [ ] Замени `SQLContext` / `HiveContext` на `SparkSession`
- [ ] Замени устаревший `Accumulator` на `AccumulatorV2`
- [ ] Обнови `DataFrame` → `Dataset[Row]` там, где нужно
- [ ] Замени удалённый `RDD.mapPartitionsWithContext` на `mapPartitions`
- [ ] Исправь устаревшие сеттеры `SparkConf`
- [ ] Обнови регистрацию кастомного `UserDefinedFunction`
- [ ] Мигрируй использования `Experimental` / `DeveloperApi`, которые были удалены
- [ ] Убедись, что все ошибки компиляции из Фазы 2 устранены

---

## Фаза 4: Миграция конфигурации

Spark переименовывает и удаляет свойства конфигурации между версиями. Официальное руководство по миграции документирует каждое переименованное и удалённое свойство по релизам:
https://spark.apache.org/docs/latest/migration-guide.html

### Чек-лист

- [ ] Переименуй устаревшие ключи конфигов (например, `spark.shuffle.file.buffer.kb` → `spark.shuffle.file.buffer`)
- [ ] Обнови удалённые конфиги их заменами
- [ ] Просмотри `spark-defaults.conf`, код приложения и submit-скрипты
- [ ] Проверь жёстко закодированные значения конфигов в тестовых фикстурах
- [ ] Убедись, что вызовы `SparkSession.builder().config(...)` используют актуальные имена свойств

---

## Фаза 5: Миграция SQL и DataFrame

Изменения поведения Spark SQL между версиями могут молча менять результаты запросов.

### Ключевые breaking changes (2.x → 3.x)

- `CAST` в integer больше не обрезает молча — при необходимости установи `spark.sql.ansi.enabled`
- Предложение `FROM` обязательно в `SELECT` (больше нет `SELECT 1`)
- Изменился порядок разрешения колонок в подзапросах
- `spark.sql.legacy.timeParserPolicy` управляет поведением парсинга даты/времени

### Ключевые breaking changes (3.x → 4.x)

- Режим ANSI включён по умолчанию (`spark.sql.ansi.enabled=true`)
- Более строгое приведение типов в сравнениях
- Флаги `spark.sql.legacy.*` удалены

### Чек-лист

- [ ] Проверь SQL-строки и выражения DataFrame на изменённое поведение
- [ ] Добавь явный `CAST`, где неявное приведение опиралось на легаси-поведение
- [ ] Обнови паттерны форматов даты/времени под новый парсер
- [ ] Протестируй SQL-запросы на репрезентативных данных и сравни вывод с базовым уровнем до обновления
- [ ] При необходимости временно установи флаги `spark.sql.legacy.*` для поэтапной миграции

---

## Фаза 6: Валидация тестов

### Чек-лист

- [ ] Весь код компилируется без ошибок
- [ ] Все существующие юнит-тесты проходят
- [ ] Все существующие интеграционные тесты проходят
- [ ] Запусти Spark-задания локально на примере данных и сравни вывод с базовым уровнем до обновления
- [ ] Не осталось предупреждений об устаревании (или они задокументированы с планом миграции)
- [ ] Обнови CI/CD-пайплайн под новую версию Spark
- [ ] Задокументируй любые временно установленные флаги `spark.sql.legacy.*`

## Готово, когда

✓ Проект компилируется под целевую версию Spark
✓ Все тесты проходят
✓ В коде не осталось удалённых API
✓ Свойства конфигурации актуальны
✓ SQL-запросы дают корректные результаты
✓ Влияние обновления задокументировано в `spark_upgrade_impact.md`
