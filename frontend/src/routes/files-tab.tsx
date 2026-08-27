/* eslint-disable i18next/no-literal-string */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

import { NoFileSelectedMessage } from "#/components/features/files-tab/no-file-selected-message";
import { I18nKey } from "#/i18n/declaration";
import { useFilesTabStore } from "#/stores/files-tab-store";
import { useWorkspaceFiles } from "#/hooks/query/use-workspace-files";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import AgentServerRuntimeService from "#/api/runtime-service/agent-server-runtime-service";
import { downloadBlob } from "#/utils/utils";
import { useWorkspaceFileContent } from "#/hooks/query/use-workspace-file-content";
import { useHasAttachedSource } from "#/hooks/use-has-attached-source";
import { useHasGitCommits } from "#/hooks/query/use-has-git-commits";
import { useAutoRefreshFilesOnEdit } from "#/hooks/use-auto-refresh-files-on-edit";
import { useUnifiedGetGitChanges } from "#/hooks/query/use-unified-get-git-changes";
import { useOptionalConversationId } from "#/hooks/use-conversation-id";
import { useConversationLocalStorageState } from "#/utils/conversation-local-storage";
import {
  useWorkspaceMutationCounter,
  withWorkspaceCacheBuster,
} from "#/stores/use-workspace-mutation-counter";
import { sortFilesByPriority } from "#/utils/file-priority";
import { FileQuickRow } from "#/components/features/files-tab/file-quick-row";
import { FileTreeView } from "#/components/features/files-tab/file-tree-view";
import { FileContentViewer } from "#/components/features/files-tab/file-content-viewer";
import { SegmentedToggle } from "#/components/features/files-tab/segmented-toggle";
import type { ViewMode } from "#/components/features/files-tab/view-mode";
import RefreshIcon from "#/icons/u-refresh.svg?react";
import LinkExternalIcon from "#/icons/link-external.svg?react";
import DownloadIcon from "#/icons/u-download.svg?react";
import PrIcon from "#/icons/u-pr.svg?react";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalBody } from "#/components/shared/modals/modal-body";
import { useUnifiedGitCommits } from "#/hooks/query/use-unified-git-commits";
import GitChanges from "./changes-tab";
import GitCommits from "./commits-tab";

function GitHubAppPrModal({
  onClose,
  onCreate,
  isCreating,
}: {
  onClose: () => void;
  onCreate: (title: string, body: string, branch: string) => void;
  isCreating: boolean;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [branch, setBranch] = useState("");
  return (
    <ModalBackdrop
      onClose={isCreating ? undefined : onClose}
      aria-label="Создать Pull Request через GitHub App"
    >
      <ModalBody width="md" className="items-stretch gap-4">
        <div>
          <h2 className="text-lg font-semibold">Создать PR через GitHub App</h2>
          <p className="mt-1 text-sm text-[var(--oh-muted)]">
            Будут опубликованы все текущие изменения рабочей области в новой
            feature-ветке. Основная ветка не изменяется.
          </p>
        </div>
        <label className="text-sm">
          Заголовок PR
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--oh-border)] bg-base p-2"
            placeholder="Кратко опишите изменения"
          />
        </label>
        <label className="text-sm">
          Описание
          <input
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--oh-border)] bg-base p-2"
            placeholder="Необязательно"
          />
        </label>
        <label className="text-sm">
          Имя ветки
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--oh-border)] bg-base p-2"
            placeholder="agenthaus/… (генерируется автоматически)"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="rounded px-3 py-2 hover:bg-[var(--oh-interactive-hover)]"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={!title.trim() || isCreating}
            onClick={() => onCreate(title.trim(), body, branch.trim())}
            className="rounded bg-primary px-3 py-2 text-white disabled:opacity-50"
          >
            {isCreating ? "Создаём PR…" : "Создать PR"}
          </button>
        </div>
      </ModalBody>
    </ModalBackdrop>
  );
}

function FilesTab() {
  const { t } = useTranslation("openhands");

  // Keep the list / content / diff caches fresh as the agent writes files.
  useAutoRefreshFilesOnEdit();

  const { hasAttachedSource, isLoading: isAttachedSourceLoading } =
    useHasAttachedSource();
  // A workspace with zero commits has no diff base to compare against, so
  // the diff view would just be empty / misleading. Only probe when we
  // already believe the user attached a source — saves a workspace round
  // trip on every plain (no-attachment) conversation.
  const { hasCommits } = useHasGitCommits({ enabled: hasAttachedSource });

  // Diff view defaults to ON when the user attached a source (repo or
  // local workspace) *and* there's at least one commit, OFF otherwise
  // (no attachment, or attachment with no commits yet).
  //
  // While the attachment / commit probes are still resolving we stay
  // optimistic — most attached conversations live in a real repo, so
  // defaulting to diff during the brief loading window avoids a
  // "files → diff" flash on initial load. We only flip to files-view
  // once `hasAttachedSource` *or* `hasCommits` definitively resolves
  // false. The user's persisted choice always wins.
  const { conversationId } = useOptionalConversationId();
  const { data: conversation } = useActiveConversation();
  const [isDownloadingArchive, setIsDownloadingArchive] = useState(false);
  const [isGitHubAppAvailable, setIsGitHubAppAvailable] = useState(false);
  const [isGitHubAppModalOpen, setIsGitHubAppModalOpen] = useState(false);
  const [isCreatingGitHubPr, setIsCreatingGitHubPr] = useState(false);
  const {
    state: persistedState,
    setFilesTabDiffView,
    setFilesTabContentViewMode,
  } = useConversationLocalStorageState(conversationId ?? "");

  const diffViewDefault =
    (hasAttachedSource || isAttachedSourceLoading) && hasCommits !== false;
  const diffViewEnabled = persistedState.filesTabDiffView ?? diffViewDefault;
  const contentViewMode = persistedState.filesTabContentViewMode;

  // Commit history gets a third toggle segment, offered only when the
  // agent server supports the commits API (older servers 404 → the toggle
  // stays two-way and the tab looks exactly as it did before). The
  // selection is session-local; the persisted diff/files preference is
  // untouched so falling out of the commits view restores it.
  const { isSuccess: commitsIsSuccess, isUnsupported: commitsUnsupported } =
    useUnifiedGitCommits();
  const showCommitsOption = commitsIsSuccess && !commitsUnsupported;
  const [commitsViewSelected, setCommitsViewSelected] = useState(false);
  let activeView: "on" | "off" | "commits" = diffViewEnabled ? "on" : "off";
  if (commitsViewSelected && showCommitsOption) activeView = "commits";

  // Collapsed by default — the quick-access pill row at the top is usually
  // enough; the user can expand the tree on demand.
  const [isTreeVisible, setIsTreeVisible] = useState(false);

  const filesQuery = useWorkspaceFiles();
  const paths = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);

  const storedSelectedPath = useFilesTabStore((s) => s.selectedPath);
  const selectedConversationId = useFilesTabStore(
    (s) => s.selectedConversationId,
  );
  const setSelectedPath = useFilesTabStore((s) => s.setSelectedPath);

  // A selection is scoped to the conversation it was made in. Ignore a path
  // that belongs to a different conversation so we never try to open a file
  // that only exists in the previous conversation's workspace (issue #1350).
  // The auto-select effect below then picks this conversation's top file.
  const selectedPath =
    selectedConversationId === conversationId ? storedSelectedPath : null;

  // Tag every selection with the active conversation so it can't leak into
  // the next one. FileQuickRow / FileTreeView call this with just the path.
  const handleSelectFile = useCallback(
    (path: string) => setSelectedPath(path, conversationId),
    [conversationId, setSelectedPath],
  );

  // Pre-fetch the selected file's content here too so the toolbar's
  // "open in new window" link can reach for its `staticUrl`. react-query
  // dedupes against `FileContentViewer`'s identical call, so this costs
  // nothing extra.
  const selectedFileContent = useWorkspaceFileContent(selectedPath);
  const mutationCounter = useWorkspaceMutationCounter((state) => state.count);
  const selectedFileStaticUrl = withWorkspaceCacheBuster(
    selectedFileContent.data?.staticUrl ?? null,
    mutationCounter,
  );

  useEffect(() => {
    if (selectedConversationId === conversationId) return;
    setSelectedPath(null, conversationId);
  }, [selectedConversationId, conversationId, setSelectedPath]);

  // Auto-select the highest-priority file the first time we load the list,
  // so users see something useful immediately.
  useEffect(() => {
    if (selectedPath || paths.length === 0) return;
    const [first] = sortFilesByPriority(paths);
    if (first) setSelectedPath(first, conversationId);
  }, [paths, selectedPath, conversationId, setSelectedPath]);

  // Refresh button: covers the diff view (git changes) and the file viewer
  // (workspace listing + cached file contents). Lives in this toolbar — not
  // in the outer ConversationTabs bar — so it sits with the other
  // files-tab-local controls.
  const queryClient = useQueryClient();
  const { refetch: refetchGitChanges, isFetching: isFetchingGitChanges } =
    useUnifiedGetGitChanges();
  const refreshFiles = () => {
    refetchGitChanges();
    queryClient.invalidateQueries({ queryKey: ["workspace-files"] });
    queryClient.invalidateQueries({ queryKey: ["workspace-file-content"] });
    queryClient.invalidateQueries({ queryKey: ["git_commits"] });
  };

  const downloadWorkspaceArchive = async () => {
    const workingDir = conversation?.workspace?.working_dir?.trim();
    if (!conversation || !workingDir || isDownloadingArchive) return;

    setIsDownloadingArchive(true);
    try {
      const archive = await AgentServerRuntimeService.downloadWorkspaceArchive(
        conversation.conversation_url,
        conversation.session_api_key,
        workingDir,
      );
      downloadBlob(archive.blob, archive.filename);
    } catch {
      // The archive is intentionally best-effort: files can change while the
      // agent works. Keep the failure local to the download control rather
      // than interrupting the running conversation.
      toast.error(t(I18nKey.CONVERSATION$DOWNLOAD_ERROR));
    } finally {
      setIsDownloadingArchive(false);
    }
  };

  const canDownloadWorkspace = !!conversation?.workspace?.working_dir?.trim();

  useEffect(() => {
    if (!conversation?.workspace?.working_dir) {
      setIsGitHubAppAvailable(false);
      return;
    }
    void AgentServerRuntimeService.getGitHubAppStatus(
      conversation.conversation_url,
      conversation.session_api_key,
    )
      .then((status) => setIsGitHubAppAvailable(status.enabled))
      .catch(() => setIsGitHubAppAvailable(false));
  }, [
    conversation?.conversation_url,
    conversation?.session_api_key,
    conversation?.workspace?.working_dir,
  ]);

  const createGitHubAppPr = async (
    title: string,
    body: string,
    branch: string,
  ) => {
    const workingDir = conversation?.workspace?.working_dir?.trim();
    if (!conversation || !workingDir || isCreatingGitHubPr) return;
    setIsCreatingGitHubPr(true);
    try {
      const result = await AgentServerRuntimeService.createGitHubAppPullRequest(
        conversation.conversation_url,
        conversation.session_api_key,
        { path: workingDir, title, body, ...(branch ? { branch } : {}) },
      );
      setIsGitHubAppModalOpen(false);
      toast.success(`PR #${result.number} создан`);
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error("Не удалось создать Pull Request через GitHub App");
    } finally {
      setIsCreatingGitHubPr(false);
    }
  };

  return (
    <main
      className="h-full w-full flex flex-col items-stretch"
      data-testid="files-tab"
    >
      {/* Top toolbar: diff/files + rich/plain toggles (left-aligned) plus
          the refresh button on the right. */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--oh-border)]">
        <SegmentedToggle<"on" | "off" | "commits">
          ariaLabel={t(I18nKey.FILES$DIFF_VIEW)}
          testId="files-tab-diff-toggle"
          value={activeView}
          options={[
            { value: "on", label: t(I18nKey.FILES$DIFF_VIEW) },
            ...(showCommitsOption
              ? [
                  {
                    value: "commits" as const,
                    label: t(I18nKey.DIFF_VIEWER$COMMITS),
                  },
                ]
              : []),
            { value: "off", label: t(I18nKey.COMMON$FILES) },
          ]}
          onChange={(value) => {
            if (value === "commits") {
              setCommitsViewSelected(true);
            } else {
              setCommitsViewSelected(false);
              setFilesTabDiffView(value === "on");
            }
          }}
        />

        {activeView === "off" && (
          <SegmentedToggle<ViewMode>
            ariaLabel={t(I18nKey.FILES$RICH)}
            testId="files-tab-content-mode-toggle"
            value={contentViewMode}
            options={[
              { value: "rich", label: t(I18nKey.FILES$RICH) },
              { value: "plain", label: t(I18nKey.FILES$PLAIN) },
            ]}
            onChange={setFilesTabContentViewMode}
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Open the currently-selected file in a new browser tab. Only
              meaningful while we're showing a file (not the diff view) and
              we've resolved its staticUrl from the workspace fileserver. */}
          {activeView === "off" && selectedFileStaticUrl && (
            <a
              href={selectedFileStaticUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(I18nKey.FILES$OPEN_IN_NEW_WINDOW)}
              title={t(I18nKey.FILES$OPEN_IN_NEW_WINDOW)}
              data-testid="files-tab-open-in-new-window"
              className="flex items-center justify-center w-[26px] py-1 rounded-[7px] hover:bg-[var(--oh-interactive-hover)] cursor-pointer text-white"
            >
              <LinkExternalIcon width={14} height={14} />
            </a>
          )}
          {isGitHubAppAvailable && (
            <button
              type="button"
              onClick={() => setIsGitHubAppModalOpen(true)}
              disabled={!canDownloadWorkspace || isCreatingGitHubPr}
              aria-label="Создать PR через GitHub App"
              title="Создать PR через GitHub App"
              data-testid="files-tab-github-app-pr"
              className="flex items-center justify-center w-[26px] py-1 rounded-[7px] hover:enabled:bg-[var(--oh-interactive-hover)] disabled:opacity-50"
            >
              <PrIcon width={14} height={14} />
            </button>
          )}
          <button
            type="button"
            onClick={downloadWorkspaceArchive}
            disabled={!canDownloadWorkspace || isDownloadingArchive}
            aria-label={t(
              I18nKey.PROJECT_MENU_CARD_CONTEXT_MENU$DOWNLOAD_FILES_LABEL,
            )}
            title={t(
              I18nKey.PROJECT_MENU_CARD_CONTEXT_MENU$DOWNLOAD_FILES_LABEL,
            )}
            data-testid="files-tab-download-archive"
            className="flex items-center justify-center w-[26px] py-1 rounded-[7px] hover:enabled:bg-[var(--oh-interactive-hover)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <DownloadIcon
              width={14}
              height={14}
              className={isDownloadingArchive ? "animate-pulse" : ""}
            />
          </button>
          <button
            type="button"
            onClick={refreshFiles}
            disabled={isFetchingGitChanges}
            aria-label={t(I18nKey.FILES$REFRESH)}
            title={t(I18nKey.FILES$REFRESH)}
            data-testid="files-tab-refresh"
            className="flex items-center justify-center w-[26px] py-1 rounded-[7px] hover:enabled:bg-[var(--oh-interactive-hover)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshIcon
              width={12.75}
              height={15}
              color="currentColor"
              className={isFetchingGitChanges ? "animate-spin" : ""}
            />
          </button>
        </div>
      </div>

      {activeView === "on" && (
        <div className="flex-1 min-h-0">
          <GitChanges />
        </div>
      )}
      {activeView === "commits" && (
        <div className="flex-1 min-h-0">
          <GitCommits />
        </div>
      )}
      {activeView === "off" && (
        <div className="flex flex-1 flex-col min-h-0">
          {filesQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--oh-muted)]">
              {t(I18nKey.FILES$LOADING_FILES)}
            </div>
          ) : (
            <>
              <FileQuickRow
                paths={paths}
                selectedPath={selectedPath}
                onSelectFile={handleSelectFile}
                isTreeVisible={isTreeVisible}
                onToggleTree={() => setIsTreeVisible((prev) => !prev)}
              />
              <div className="flex h-full min-h-0 flex-1">
                {isTreeVisible && (
                  <aside
                    className="w-56 shrink-0 border-r border-[var(--oh-border)] overflow-y-auto custom-scrollbar-always"
                    data-testid="files-tab-tree"
                  >
                    <FileTreeView
                      paths={paths}
                      selectedPath={selectedPath}
                      onSelectFile={handleSelectFile}
                    />
                  </aside>
                )}
                <section
                  className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
                  data-testid="files-tab-content"
                >
                  {selectedPath ? (
                    <FileContentViewer
                      path={selectedPath}
                      viewMode={contentViewMode}
                    />
                  ) : (
                    <NoFileSelectedMessage />
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      )}
      {isGitHubAppModalOpen && (
        <GitHubAppPrModal
          onClose={() => setIsGitHubAppModalOpen(false)}
          onCreate={createGitHubAppPr}
          isCreating={isCreatingGitHubPr}
        />
      )}
    </main>
  );
}

export default FilesTab;
