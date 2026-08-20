---
name: pdflatex
description: Установка и использование pdflatex для компиляции LaTeX-документов в PDF на Linux. Используй при генерации научных статей, исследовательских публикаций или любых документов, написанных на LaTeX.
triggers:
- pdflatex
---

PdfLatex — это инструмент, который преобразует исходники LaTeX в PDF. Это особенно важно для исследователей, так как они используют его для публикации своих результатов. Его можно легко установить через терминал Linux, хотя на Windows это кажется утомительной задачей. Команды установки приведены ниже.

* Установи базу TexLive

```
apt-get install texlive-latex-base
```

На Windows установи MiKTeX или TeX Live с помощью нативного установщика или менеджера пакетов, такого как `winget`. Команды `apt-get` работают только в Linux или WSL.

* Также установи рекомендуемые и дополнительные шрифты, чтобы избежать ошибок при использовании pdflatex с файлами LaTeX, содержащими больше шрифтов.

```
apt-get install texlive-fonts-recommended
apt-get install texlive-fonts-extra
```

* Установи дополнительные пакеты,

```
apt-get install texlive-latex-extra
```

После установки, как описано выше, ты сможешь создавать PDF-файлы из исходников LaTeX с помощью PdfLatex следующим образом.
```
pdflatex latex_source_name.tex
```

Ссылка: http://kkpradeeban.blogspot.com/2014/04/installing-latexpdflatex-on-ubuntu.html
