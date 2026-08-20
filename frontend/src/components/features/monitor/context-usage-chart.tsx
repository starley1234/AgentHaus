import React from "react";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";

/**
 * SVG-график использования контекста за последние 24 часа.
 *
 * Данные берутся из метрик диалогов: у каждого conversation в
 * `stats.usage_to_metrics[*].token_usages[]` есть `prompt_tokens`
 * (размер контекста на ход) и `per_turn_token`. Агрегируем их в часовые
 * бакеты за 24ч и рисуем ломаную + область. Нарисовано на чистом SVG —
 * без внешних библиотек графиков.
 */

interface ContextPoint {
  hourLabel: string;
  tokens: number;
  maxTokens: number; // размер контекстного окна (если известен)
}

function collectPoints(conversations: AppConversation[]): ContextPoint[] {
  const buckets = new Map<number, { tokens: number; max: number }>();
  const now = Date.now();
  const start = now - 24 * 3600 * 1000;

  for (const c of conversations) {
    const updated = c.updated_at ? new Date(c.updated_at).getTime() : NaN;
    if (Number.isNaN(updated) || updated < start) continue;

    // AppConversation несёт агрегированные метрики в `metrics.accumulated_token_usage`.
    const acc = c.metrics?.accumulated_token_usage;
    const tokens = acc?.prompt_tokens || 0;
    const max = acc?.context_window || 0;
    if (tokens === 0) continue;

    const hour = Math.floor((updated - start) / 3600_000); // 0..23
    const b = buckets.get(hour) ?? { tokens: 0, max: 0 };
    b.tokens += tokens;
    if (max) b.max = Math.max(b.max, max);
    buckets.set(hour, b);
  }

  const points: ContextPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const b = buckets.get(h);
    const d = new Date(start + h * 3600_000);
    points.push({
      hourLabel: d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
      tokens: b?.tokens ?? 0,
      maxTokens: b?.max ?? 0,
    });
  }
  return points;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const W = 800;
const H = 180;
const PAD = { l: 46, r: 12, t: 14, b: 26 };

export function ContextUsageChart({
  conversations,
}: {
  conversations: AppConversation[];
}) {
  const points = React.useMemo(
    () => collectPoints(conversations),
    [conversations],
  );

  const maxVal = Math.max(1, ...points.map((p) => p.tokens));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * innerW;
  const y = (v: number) => PAD.t + innerH - (v / maxVal) * innerH;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${PAD.t + innerH} L${x(0).toFixed(1)},${PAD.t + innerH} Z`;

  // Только ненулевые точки для подписей оси X
  const xTicks = [0, 6, 12, 18, 23].filter((i) => i < points.length);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label="Использование контекста за 24 часа"
    >
      {/* сетка */}
      {[0.25, 0.5, 0.75, 1].map((f) => {
        const yy = PAD.t + innerH * (1 - f);
        return (
          <g key={f}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={yy}
              y2={yy}
              stroke="var(--oh-border)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={PAD.l - 6}
              y={yy + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--oh-text-tertiary)"
            >
              {formatTokens(maxVal * f)}
            </text>
          </g>
        );
      })}

      {/* область + линия */}
      <path d={area} fill="var(--oh-accent, #5b5ff0)" opacity="0.12" />
      <path
        d={path}
        fill="none"
        stroke="var(--oh-accent, #5b5ff0)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* точки + подписи оси X */}
      {points.map((p, i) =>
        p.tokens > 0 ? (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.tokens)}
            r="2.5"
            fill="var(--oh-accent, #5b5ff0)"
          />
        ) : null,
      )}
      {xTicks.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 8}
          textAnchor="middle"
          fontSize="10"
          fill="var(--oh-text-tertiary)"
        >
          {points[i]?.hourLabel}
        </text>
      ))}
    </svg>
  );
}
