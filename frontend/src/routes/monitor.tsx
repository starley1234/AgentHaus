import React from "react";
import { useTranslation } from "react-i18next";
import { Activity, RadioTower, FolderOpen, Cpu } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";
import { usePaginatedConversations } from "#/hooks/query/use-paginated-conversations";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { isNoBackend } from "#/api/backend-registry/active-store";
import type { ExecutionStatus } from "#/types/agent-server/core/base/common";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import { settingsLikeMainScrollClassName } from "#/utils/settings-like-page-layout-classes";
import { ContextUsageChart } from "#/components/features/monitor/context-usage-chart";

/**
 * Monitor page — a live dashboard of every process running on the backend.
 *
 * Reuses the same paginated conversation feed the home screen uses (polled
 * every 10s), but presents it from an operations point of view: which
 * conversations are currently executing, their model, working directory and
 * last-updated time, and a quick status breakdown. It deliberately needs no
 * new backend endpoint — `GET /api/conversations` already carries
 * `execution_status` for every conversation.
 */

const STATUS_ORDER: string[] = [
  "running",
  "waiting_for_confirmation",
  "paused",
  "idle",
  "finished",
  "error",
  "stuck",
];

const STATUS_TONE: Record<
  string,
  { dot: string; badge: string; labelKey: I18nKey }
> = {
  running: {
    dot: "bg-emerald-500",
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
    labelKey: I18nKey.MONITOR$STATUS_RUNNING,
  },
  waiting_for_confirmation: {
    dot: "bg-amber-500",
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    labelKey: I18nKey.MONITOR$STATUS_WAITING,
  },
  paused: {
    dot: "bg-sky-500",
    badge: "border-sky-500/40 bg-sky-500/10 text-sky-500",
    labelKey: I18nKey.MONITOR$STATUS_PAUSED,
  },
  idle: {
    dot: "bg-slate-400",
    badge: "border-slate-400/40 bg-slate-400/10 text-slate-400",
    labelKey: I18nKey.MONITOR$STATUS_IDLE,
  },
  finished: {
    dot: "bg-emerald-300",
    badge: "border-emerald-300/40 bg-emerald-300/10 text-emerald-300",
    labelKey: I18nKey.MONITOR$STATUS_FINISHED,
  },
  error: {
    dot: "bg-red-500",
    badge: "border-red-500/40 bg-red-500/10 text-red-500",
    labelKey: I18nKey.MONITOR$STATUS_ERROR,
  },
  stuck: {
    dot: "bg-fuchsia-500",
    badge: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-500",
    labelKey: I18nKey.MONITOR$STATUS_STUCK,
  },
};

const DEFAULT_TONE = STATUS_TONE.idle;
const ACTIVE_STATUSES = new Set([
  "running",
  "waiting_for_confirmation",
  "paused",
]);

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusBadge(
  status: ExecutionStatus | null,
  t: (key: I18nKey) => string,
) {
  const tone = (status && STATUS_TONE[status]) || DEFAULT_TONE;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {t(tone.labelKey)}
    </span>
  );
}

export default function Monitor() {
  const { t } = useTranslation("openhands");
  const active = useActiveBackend();
  const hasBackend = !isNoBackend(active.backend);

  const { data, isLoading, isError } = usePaginatedConversations(100);

  const conversations = React.useMemo(
    () => (data?.pages ?? []).flatMap((page) => page.items ?? []),
    [data],
  );

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of conversations) {
      const s = c.execution_status ?? "idle";
      map[s] = (map[s] ?? 0) + 1;
    }
    return map;
  }, [conversations]);

  const ordered = React.useMemo(() => {
    const sorted = [...conversations].sort((a, b) => {
      const sa = STATUS_ORDER.indexOf(a.execution_status ?? "idle");
      const sb = STATUS_ORDER.indexOf(b.execution_status ?? "idle");
      if (sa !== sb) return sa - sb;
      return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    });
    return {
      active: sorted.filter((c) =>
        ACTIVE_STATUSES.has(c.execution_status ?? ""),
      ),
      rest: sorted.filter((c) => !ACTIVE_STATUSES.has(c.execution_status ?? "")),
    };
  }, [conversations]);

  if (!hasBackend) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--oh-text-tertiary)]">
        {t(I18nKey.MONITOR$NO_BACKEND)}
      </div>
    );
  }

  return (
    <div className={settingsLikeMainScrollClassName}>
      <div className="mx-auto flex w-full min-w-0 max-w-[900px] flex-col gap-6 px-4 md:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-medium leading-6 text-foreground">
              {t(I18nKey.MONITOR$TITLE)}
            </h2>
            <p className="max-w-2xl text-sm text-[var(--oh-text-tertiary)]">
              {t(I18nKey.MONITOR$SUBTITLE)}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--oh-text-tertiary)]">
            <RadioTower width={14} height={14} aria-hidden />
            {isLoading ? t(I18nKey.MONITOR$LOADING) : t(I18nKey.MONITOR$LIVE)}
          </div>
        </header>

        {/* Context usage over last 24h */}
        <section className="flex flex-col gap-2 rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)] p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              {t(I18nKey.MONITOR$CONTEXT_TITLE)}
            </h3>
            <span className="text-xs text-[var(--oh-text-tertiary)]">
              {t(I18nKey.MONITOR$CONTEXT_SUBTITLE)}
            </span>
          </div>
          {conversations.length === 0 ? (
            <p className="text-sm text-[var(--oh-text-tertiary)]">
              {t(I18nKey.MONITOR$EMPTY)}
            </p>
          ) : (
            <ContextUsageChart conversations={conversations} />
          )}
        </section>

        {/* Status overview tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {([
            "running",
            "idle",
            "finished",
            "error",
          ] as (keyof typeof STATUS_TONE)[]).map((s) => {
            const n = counts[s] ?? 0;
            const tone = STATUS_TONE[s] ?? DEFAULT_TONE;
            return (
              <div
                key={s}
                className="flex flex-col gap-1 rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)] p-3"
              >
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--oh-text-tertiary)] uppercase tracking-wide">
                  <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                  {t(tone.labelKey)}
                </span>
                <span className="text-2xl font-semibold text-foreground">
                  {n}
                </span>
              </div>
            );
          })}
        </section>

        {isError ? (
          <p className="text-sm text-red-500">{t(I18nKey.MONITOR$ERROR)}</p>
        ) : isLoading ? (
          <p className="text-sm text-[var(--oh-text-tertiary)]">
            {t(I18nKey.MONITOR$LOADING)}
          </p>
        ) : conversations.length === 0 ? (
          <p className="text-sm text-[var(--oh-text-tertiary)]">
            {t(I18nKey.MONITOR$EMPTY)}
          </p>
        ) : (
          <>
            <MonitorList
              title={t(I18nKey.MONITOR$ACTIVE_TITLE)}
              items={ordered.active}
            />
            <MonitorList
              title={t(I18nKey.MONITOR$RECENT_TITLE)}
              items={ordered.rest}
            />
          </>
        )}
      </div>
    </div>
  );
}

function MonitorList({ title, items }: { title: string; items: AppConversation[] }) {
  const { t } = useTranslation("openhands");
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="flex flex-col divide-y divide-[var(--oh-border)] rounded-lg border border-[var(--oh-border)] bg-[var(--oh-surface)]">
        {items.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 px-3 py-2.5">
            <div className="flex items-center gap-2">
              {statusBadge(c.execution_status, t)}
              <span className="truncate text-sm font-medium text-foreground">
                {c.title || t(I18nKey.CONVERSATION$UNTITLED)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--oh-text-tertiary)]">
              {c.llm_model ? (
                <span className="inline-flex items-center gap-1">
                  <Cpu width={12} height={12} aria-hidden />
                  {c.llm_model}
                </span>
              ) : null}
              {c.workspace?.working_dir ? (
                <span
                  className="inline-flex max-w-[280px] items-center gap-1 truncate"
                  title={c.workspace.working_dir}
                >
                  <FolderOpen width={12} height={12} aria-hidden />
                  <span className="truncate font-mono">
                    {c.workspace.working_dir}
                  </span>
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <Activity width={12} height={12} aria-hidden />
                {formatTime(c.updated_at)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
