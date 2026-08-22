module.exports = async ({ github, context, core }) => {
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const summary = (process.env.SUMMARY || "").trim();
  const classification = process.env.CLASSIFICATION || "no-match";
  const autoClose = process.env.AUTO_CLOSE_CANDIDATE === "true";
  const closeAfterDays = process.env.CLOSE_AFTER_DAYS || "3";
  let candidates = [];
  try {
    candidates = JSON.parse(process.env.CANDIDATE_ISSUES_JSON || "[]");
  } catch (error) {
    core.setFailed(`Неверный JSON кандидатов: ${error.message}`);
    return;
  }
  if (!Array.isArray(candidates)) {
    core.setFailed("CANDIDATE_ISSUES_JSON не является массивом");
    return;
  }
  if (candidates.length === 0) {
    core.warning(`Кандидаты в дубликаты не возвращены для issue #${issueNumber}; пропускаем.`);
    return;
  }

  const canonicalIssueRaw = process.env.CANONICAL_ISSUE_NUMBER || candidates[0].number;
  const canonicalIssueNumber = canonicalIssueRaw ? Number(canonicalIssueRaw) : Number.NaN;
  const candidateLabel = "duplicate-candidate";

  function parseDuplicateCheckMarker(body) {
    if (!body) return null;
    const match = body.match(/<!-- openhands-duplicate-check canonical=(\d+) auto-close=(true|false) -->/);
    if (!match) return null;
    return {
      canonicalIssueNumber: Number(match[1]),
      autoClose: match[2] === "true",
    };
  }

  async function ensureCanonicalIssueIsOpenIssue() {
    let canonicalIssue;
    try {
      ({ data: canonicalIssue } = await github.rest.issues.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: canonicalIssueNumber,
      }));
    } catch (error) {
      if (error.status === 404) {
        core.setFailed(`Канонический issue #${canonicalIssueNumber} не существует.`);
        return false;
      }
      throw error;
    }
    if (canonicalIssue.pull_request) {
      core.setFailed(`Канонический issue #${canonicalIssueNumber} является пулл-реквестом, а не issue.`);
      return false;
    }
    if (canonicalIssue.state !== "open" || canonicalIssue.locked) {
      core.setFailed(`Канонический issue #${canonicalIssueNumber} должен быть открытым, незаблокированным issue.`);
      return false;
    }
    return true;
  }

  async function ensureCandidateLabelOnIssue() {
    try {
      await github.rest.issues.getLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: candidateLabel,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
      await github.rest.issues.createLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: candidateLabel,
        color: "f97316",
        description: "Потенциальный дубликат, ожидающий автозакрытия или проверки мейнтейнером",
      });
    }

    const { data: issue } = await github.rest.issues.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
    });
    const labelNames = (issue.labels || []).map((label) =>
      typeof label === "string" ? label : label.name,
    );
    if (!labelNames.includes(candidateLabel)) {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issueNumber,
        labels: [candidateLabel],
      });
    }
  }

  async function removeCandidateLabelFromIssue() {
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issueNumber,
        name: candidateLabel,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  if (!Number.isInteger(canonicalIssueNumber) || canonicalIssueNumber <= 0) {
    core.setFailed(`Канонический номер issue не был возвращён для issue #${issueNumber}.`);
    return;
  }
  if (canonicalIssueNumber === issueNumber) {
    core.setFailed(`Проверка дубликатов не может пометить issue #${issueNumber} как дубликат самого себя.`);
    return;
  }

  if (!(await ensureCanonicalIssueIsOpenIssue())) return;

  const marker = `<!-- openhands-duplicate-check canonical=${canonicalIssueNumber} auto-close=${autoClose ? "true" : "false"} -->`;
  const header = candidates.length === 1
    ? "Найден 1 возможный дубликат issue:"
    : `Найдено ${candidates.length} возможных дубликатов issue:`;
  const candidateLines = candidates.map((candidate, index) =>
    `${index + 1}. [#${candidate.number}](${candidate.url}) — ${candidate.title}`,
  );

  const sections = [];
  if (summary) sections.push(summary, "");
  sections.push(header, "", ...candidateLines);

  if (classification === "overlapping-scope") {
    sections.push(
      "",
      "Это могут быть не точные дубликаты, но область, похоже, достаточно пересекается, чтобы обсуждение в одном месте было более полезным.",
    );
  }

  if (autoClose) {
    sections.push(
      "",
      `Этот issue будет автоматически закрыт как дубликат через ${closeAfterDays} дней.`,
      "",
      "- Если ваш issue — дубликат, пожалуйста, закройте его и поставьте 👍 существующему issue",
      "- Чтобы предотвратить автозакрытие, добавьте комментарий или поставьте 👎 этому комментарию",
    );
  }

  sections.push(
    "",
    marker,
    "_Этот комментарий был создан ИИ-ассистентом (OpenHands) от имени мейнтейнера репозитория._",
  );
  const body = sections.join("\n").trim();

  const maxCommentPages = 50;
  let allComments = [];
  let page = 1;
  while (page <= maxCommentPages) {
    const { data: comments } = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    if (!comments || comments.length === 0) break;
    allComments = allComments.concat(comments);
    if (comments.length < 100) break;
    page += 1;
  }
  if (page > maxCommentPages) {
    core.setFailed(`Остановлена загрузка комментариев для issue #${issueNumber} после ${maxCommentPages} страниц.`);
    return;
  }

  const existing = allComments.find((comment) =>
    comment.body && comment.body.includes("<!-- openhands-duplicate-check "),
  );
  if (existing) {
    const existingMarker = parseDuplicateCheckMarker(existing.body);
    if (existingMarker) {
      if (
        existingMarker.canonicalIssueNumber !== canonicalIssueNumber ||
        existingMarker.autoClose !== autoClose
      ) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existing.id,
          body,
        });
        if (autoClose) await ensureCandidateLabelOnIssue();
        else await removeCandidateLabelFromIssue();
        core.info(`Обновлён существующий комментарий проверки дубликатов ${existing.id} на issue #${issueNumber}.`);
        return;
      }
      if (autoClose) await ensureCandidateLabelOnIssue();
      else await removeCandidateLabelFromIssue();
    } else {
      core.warning(
        `Комментарий проверки дубликатов уже существует на issue #${issueNumber}, но его маркер не удалось распарсить; состояние метки не изменено.`,
      );
    }
    core.info(`Комментарий проверки дубликатов уже существует на issue #${issueNumber}; пропускаем.`);
    return;
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    body,
  });

  if (autoClose) await ensureCandidateLabelOnIssue();
};
