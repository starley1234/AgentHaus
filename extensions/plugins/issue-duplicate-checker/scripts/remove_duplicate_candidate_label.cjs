module.exports = async ({ github, context, core }) => {
  const issueNumber = context.issue.number;
  const commenter = context.payload.comment?.user?.login ?? "";
  const normalizedCommenter = commenter.toLowerCase();

  if (normalizedCommenter.endsWith("[bot]") || normalizedCommenter === "all-hands-bot") {
    core.info(`Пропуск удаления метки duplicate-candidate для комментария бота от ${commenter || "неизвестный"}`);
    return;
  }

  core.info(`Удаление метки duplicate-candidate с issue #${issueNumber} после комментария от ${commenter}`);

  try {
    await github.rest.issues.removeLabel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      name: "duplicate-candidate",
    });
  } catch (error) {
    if (error.status === 404) {
      core.info(`Метка duplicate-candidate уже была удалена с issue #${issueNumber}`);
      return;
    }
    throw error;
  }
};
