"use client";

import { useState, useMemo } from "react";

/* ── date navigator ── */
export function DateNav({
  date,
  label,
  isToday,
  onPrev,
  onNext,
  onPick,
}: {
  date: string;
  label: string;
  isToday: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center overflow-hidden rounded-[2px] border border-border bg-surface-2">
      <button onClick={onPrev} title="Previous day" className="h-7 px-[9px] text-[0.9rem] leading-none text-muted-2 transition-colors hover:bg-accent-3/[0.08] hover:text-accent-3">
        ‹
      </button>
      <label className="relative cursor-pointer border-x border-border px-[6px]">
        <span className={`mono whitespace-nowrap text-[0.63rem] tracking-[0.06em] ${isToday ? "text-accent" : "text-muted-2"}`}>
          {label}
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <button onClick={onNext} disabled={isToday} title="Next day" className="h-7 px-[9px] text-[0.9rem] leading-none text-muted-2 transition-colors enabled:hover:bg-accent-3/[0.08] enabled:hover:text-accent-3 disabled:opacity-30">
        ›
      </button>
    </div>
  );
}

/* ── stat strip ── */
export type Stat = { label: string; value: string; sub?: string; tone?: string };
export function StatStrip({ stats }: { stats: Stat[] }) {
  if (!stats.length) return null;
  return (
    <div className="stat-strip mb-4">
      {stats.map((s, i) => (
        <div key={i} className="stat-cell">
          <div className="stat-label">{s.label}</div>
          <div className="stat-val" style={s.tone ? { color: s.tone } : undefined}>
            {s.value}
          </div>
          {s.sub && <div className="stat-sub">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* ── probability / vulnerability bar ── */
export function Bar({ pct, color, width = 110 }: { pct: number; color: string; width?: number }) {
  return (
    <div className="flex items-center gap-[7px]" style={{ minWidth: width }}>
      <div className="track">
        <div className="fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

/* ── loading / empty / error states ── */
export function Loading({ msg = "Loading…" }: { msg?: string }) {
  return (
    <div className="state-msg">
      <div className="spin" />
      <div>{msg}</div>
    </div>
  );
}
export function Empty({ icon = "○", msg }: { icon?: string; msg: string }) {
  return (
    <div className="state-msg">
      <span className="text-[1.6rem]">{icon}</span>
      <div>{msg}</div>
    </div>
  );
}

/* ── generic client-side sortable table ──
   columns: { key, label, num?, render?, sortVal? } */
export type Col<T> = {
  key: string;
  label: string;
  num?: boolean;
  render?: (row: T, i: number) => React.ReactNode;
  sortVal?: (row: T) => number | string;
  className?: string;
};

export function SortTable<T>({
  rows,
  cols,
  initialSort,
  initialDir = "desc",
  rowKey,
}: {
  rows: T[];
  cols: Col<T>[];
  initialSort?: string;
  initialDir?: "asc" | "desc";
  rowKey: (row: T, i: number) => string;
}) {
  const [sort, setSort] = useState<string | undefined>(initialSort);
  const [dir, setDir] = useState<"asc" | "desc">(initialDir);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort);
    if (!col) return rows;
    const get = col.sortVal ?? ((r: T) => (r as Record<string, unknown>)[col.key] as number | string);
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return dir === "asc" ? va - vb : vb - va;
      return dir === "asc" ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return copy;
  }, [rows, cols, sort, dir]);

  const click = (key: string) => {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir("desc");
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="dt">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} onClick={() => click(c.key)} className={c.num ? "text-right" : ""}>
                {c.label}
                {sort === c.key && <span className="text-accent"> {dir === "asc" ? "↑" : "↓"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className="reveal" style={{ animationDelay: `${Math.min(i * 18, 360)}ms` }}>
              {cols.map((c) => (
                <td key={c.key} className={[c.num ? "num text-right" : "", c.className || ""].join(" ")}>
                  {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
