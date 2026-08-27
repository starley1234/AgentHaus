import React from "react";
import { useTranslation } from "react-i18next";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalCloseButton } from "#/components/shared/modals/modal-close-button";
import { BrandButton } from "#/components/features/settings/brand-button";
import { SettingsSwitch } from "#/components/features/settings/settings-switch";
import { I18nKey } from "#/i18n/declaration";
import type { SkillInfo } from "#/types/settings";
import { cn } from "#/utils/utils";
import { modalTitleLgClassName } from "#/utils/modal-classes";
import CopyIcon from "#/icons/copy.svg?react";
import CheckmarkIcon from "#/icons/checkmark.svg?react";
import MessageSquareShareIcon from "#/icons/message-square-share.svg?react";
import { SkillIconBadge } from "./skill-icon-badge";
import { getSkillCardDescription } from "./get-skill-card-description";
import { buildSkillPills } from "./build-skill-pills";
import { isCopyableSkillSource } from "./is-copyable-skill-source";
import { SkillCardPillRow } from "./skill-card-pill-row";
import { getSkillChatLaunchMessage } from "./get-skill-chat-launch-message";
import { useLaunchSkillInChat } from "#/hooks/use-launch-skill-in-chat";
import { useUninstallSkill } from "#/hooks/mutation/use-uninstall-skill";

interface SkillDetailModalProps {
  skill: SkillInfo;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onClose: () => void;
  onDelete?: (skillName: string) => void;
}

function isDeletableSkill(skill: SkillInfo): boolean {
  // Public навыки (source === "public") нельзя удалить, только отключить
  // Удаляемые — те, что установлены в ~/.openhands/skills/installed
  // Навыки вида "agents:..." или "agents:frontend" — это path-правила из AGENTS.md,
  // они генерируются автоматически и не удаляются через API uninstall.
  if (!skill.source) return false;
  if (skill.source === "public") return false;

  // Проверка паттерна имени для uninstall API: ^[a-z0-9]+(-[a-z0-9]+)*$
  // Если имя не соответствует (содержит :, /, и т.д.) — это не installed skill
  const validNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!validNamePattern.test(skill.name)) return false;

  // Если source содержит путь к installed — считаем удаляемым
  const src = skill.source.toLowerCase();
  return (
    src.includes("installed") ||
    src.includes(".agents/skills") ||
    src.includes(".openhands/skills")
  );
}

function isPathRuleSkill(skill: SkillInfo): boolean {
  // Path-правила вида "agents:..." генерируются из AGENTS.md / CLAUDE.md
  return skill.name.includes(":") || skill.name.startsWith("agents");
}

function getSkillTypeLabel(skill: SkillInfo): string {
  if (skill.source === "public") return "Публичный (из @openhands/extensions)";
  if (isPathRuleSkill(skill)) return "Авто-правило из AGENTS.md / CLAUDE.md";
  if (skill.source.toLowerCase().includes("installed")) return "Установленный";
  if (skill.source.toLowerCase().includes(".agents/skills")) return "Пользовательский (.agents/skills)";
  return "Проектый";
}

function ReadonlyTextArea({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: string;
}) {
  return (
    <label className="flex min-w-0 w-full flex-col gap-2.5">
      <span className="text-sm">{label}</span>
      <textarea
        data-testid={testId}
        readOnly
        value={value}
        rows={Math.min(12, Math.max(4, value.split("\n").length))}
        className={cn(
          "bg-[var(--oh-surface-raised)] border border-[var(--oh-border-subtle)] w-full min-w-0 rounded-sm p-2 text-sm",
          "cursor-not-allowed resize-none custom-scrollbar",
        )}
      />
    </label>
  );
}

export function SkillDetailModal({
  skill,
  enabled,
  onToggle,
  onClose,
  onDelete,
}: SkillDetailModalProps) {
  const { t } = useTranslation("openhands");
  const launchSkillInChat = useLaunchSkillInChat();
  const uninstallSkill = useUninstallSkill();
  const [sourceCopied, setSourceCopied] = React.useState(false);
  const chatLaunchMessage = React.useMemo(
    () => getSkillChatLaunchMessage(skill),
    [skill],
  );

  const deletable = isDeletableSkill(skill);
  const pathRule = isPathRuleSkill(skill);
  const typeLabel = getSkillTypeLabel(skill);

  const handleDelete = () => {
    const confirmMessage = t(I18nKey.SETTINGS$SKILLS_DELETE_CONFIRM);
    if (!window.confirm(confirmMessage)) return;
    uninstallSkill.mutate(skill.name, {
      onSuccess: () => {
        onDelete?.(skill.name);
        onClose();
      },
    });
  };

  const description = getSkillCardDescription(skill);
  const pills = React.useMemo(
    () =>
      buildSkillPills(skill, t, {
        variant: "detail",
        testIdPrefix: "skill-modal-pill",
      }),
    [skill, t],
  );
  const showCopySource = isCopyableSkillSource(skill.source);

  const handleCopySource = async () => {
    if (!skill.source) {
      return;
    }

    await navigator.clipboard.writeText(skill.source);
    setSourceCopied(true);
  };

  React.useEffect(() => {
    if (!sourceCopied) {
      return undefined;
    }

    const timeout = setTimeout(() => setSourceCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [sourceCopied]);

  return (
    <ModalBackdrop onClose={onClose} aria-label={skill.name}>
      <div
        data-testid="skill-detail-modal"
        data-skill-name={skill.name}
        className="relative bg-base-secondary p-6 rounded-xl flex flex-col gap-4 border border-[var(--oh-border)] w-[520px] max-w-[90vw] max-h-[85vh] overflow-y-auto custom-scrollbar"
      >
        <ModalCloseButton onClose={onClose} testId="skill-detail-modal-close" />
        <div className="flex items-start gap-3 pr-6">
          <SkillIconBadge skillName={skill.name} />
          <div className="min-w-0 flex-1">
            <h2
              data-testid={`skill-modal-name-${skill.name}`}
              className={modalTitleLgClassName}
            >
              {skill.name}
            </h2>
            <p className="text-xs text-tertiary-light mt-1">{typeLabel}</p>
            {skill.source ? (
              <div className="mt-0.5 flex min-w-0 items-center gap-1">
                <p
                  data-testid={`skill-modal-source-${skill.name}`}
                  className="min-w-0 flex-1 truncate text-xs text-tertiary-alt"
                  title={skill.source}
                >
                  {skill.source}
                </p>
                {showCopySource ? (
                  <button
                    type="button"
                    data-testid={`skill-modal-copy-source-${skill.name}`}
                    aria-label={t(
                      sourceCopied
                        ? I18nKey.BUTTON$COPIED
                        : I18nKey.SETTINGS$SKILLS_COPY_PATH,
                    )}
                    disabled={sourceCopied}
                    onClick={handleCopySource}
                    className="shrink-0 cursor-pointer border-0 bg-transparent p-0.5 text-tertiary-alt hover:text-white disabled:cursor-default [&_path]:fill-current"
                  >
                    {sourceCopied ? (
                      <CheckmarkIcon width={12} height={12} />
                    ) : (
                      <CopyIcon width={12} height={12} />
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {pathRule ? (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
            <p className="font-medium">⚠️ Авто-правило из AGENTS.md</p>
            <p className="mt-1 text-tertiary-light">
              Этот навык сгенерирован автоматически из файла <code>AGENTS.md</code> или <code>CLAUDE.md</code> в проекте. 
              Его нельзя удалить через API, только отключив переключателем выше или удалив/отредактировав исходный файл.
              <br />
              Имя <code>{skill.name}</code> не соответствует паттерну для установленных навыков, поэтому API возвращает 422.
            </p>
          </div>
        ) : null}

        <div
          data-testid={`skill-modal-enable-row-${skill.name}`}
          className="flex w-full items-center rounded-lg border border-[var(--oh-border)] bg-[rgba(255,255,255,0.04)] px-3 py-2.5"
        >
          <SettingsSwitch
            testId={`skill-modal-toggle-${skill.name}`}
            isToggled={enabled}
            onToggle={onToggle}
            togglePosition="right"
          >
            {t(
              enabled
                ? I18nKey.SETTINGS$SKILLS_ENABLED
                : I18nKey.SETTINGS$SKILLS_DISABLED,
            )}
          </SettingsSwitch>
        </div>

        {description ? (
          <p
            data-testid={`skill-modal-description-${skill.name}`}
            className="text-xs text-tertiary-light"
          >
            {description}
          </p>
        ) : null}

        {pills.length > 0 ? (
          <SkillCardPillRow
            pills={pills}
            testId={`skill-modal-pills-${skill.name}`}
          />
        ) : null}

        {skill.content ? (
          <ReadonlyTextArea
            testId={`skill-modal-field-content-${skill.name}`}
            label={t(I18nKey.SETTINGS$SKILLS_CONTENT)}
            value={skill.content}
          />
        ) : null}

        <div className="mt-2 flex justify-between gap-2">
          <div>
            {deletable ? (
              <BrandButton
                type="button"
                variant="secondary"
                onClick={handleDelete}
                testId={`skill-detail-uninstall-${skill.name}`}
                isDisabled={uninstallSkill.isPending}
                className="text-red-400 hover:text-red-300 border-red-500/30"
              >
                {uninstallSkill.isPending
                  ? t(I18nKey.SETTINGS$SKILLS_UNINSTALL) + "..."
                  : t(I18nKey.SETTINGS$SKILLS_UNINSTALL)}
              </BrandButton>
            ) : null}
          </div>
          <div className="flex gap-2">
            <BrandButton
              type="button"
              variant="secondary"
              onClick={onClose}
              testId="skill-detail-close"
            >
              {t(I18nKey.BUTTON$CLOSE)}
            </BrandButton>
            <BrandButton
              type="button"
              variant="primary"
              isDisabled={!enabled}
              onClick={() => launchSkillInChat(chatLaunchMessage, onClose)}
              testId={`skill-detail-use-skill-${skill.name}`}
              startContent={
                <MessageSquareShareIcon className="size-4" aria-hidden />
              }
            >
              {t(I18nKey.SETTINGS$SKILLS_USE_SKILL_BUTTON)}
            </BrandButton>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  );
}
