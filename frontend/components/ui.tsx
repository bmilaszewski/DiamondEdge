"use client";

import { useState, useMemo, useEffect, useRef, type RefObject } from "react";

/* ── reduced-motion check ── */
function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/* ── IntersectionObserver hook (fires once) ── */
export function useInView<T extends Element>(ref: RefObject<T | null>, rootMargin = "0px 0px -8% 0px") {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/* ── count-up numeral (animates to target when scrolled into view) ── */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 850,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref);
  const [display, setDisplay] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!inView || started.current) return;
    started.current = true;
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {(Number.isFinite(display) ? display : 0).toFixed(decimals)}
      {suffix}
    </span>
  );
}

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
      <button
        onClick={onPrev}
        aria-label="Previous day"
        title="Previous day"
        className="h-7 px-[9px] text-[0.9rem] leading-none text-muted-2 transition-colors hover:bg-accent-3/[0.08] hover:text-accent-3"
      >
        ‹
      </button>
      <label className="relative cursor-pointer border-x border-border px-[6px]">
        <span className={`mono whitespace-nowrap text-[0.63rem] tracking-[0.06em] ${isToday ? "text-accent" : "text-muted-2"}`}>
          {label}
        </span>
        <input
          type="date"
          aria-label="Pick a date"
          value={date}
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <button
        onClick={onNext}
        disabled={isToday}
        aria-label="Next day"
        title="Next day"
        className="h-7 px-[9px] text-[0.9rem] leading-none text-muted-2 transition-colors enabled:hover:bg-accent-3/[0.08] enabled:hover:text-accent-3 disabled:opacity-30"
      >
        ›
      </button>
    </div>
  );
}

/* ── stat strip (with count-up numerals) ── */
export type Stat = { label: string; value: string; sub?: string; tone?: string; count?: { to: number; decimals?: number; prefix?: string; suffix?: string } };
export function StatStrip({ stats }: { stats: Stat[] }) {
  if (!stats.length) return null;
  return (
    <div className="stat-strip mb-4">
      {stats.map((s, i) => (
        <div key={i} className="stat-cell">
          <div className="stat-label">{s.label}</div>
          <div className="stat-val" style={s.tone ? { color: s.tone } : undefined}>
            {s.count ? (
              <CountUp value={s.count.to} decimals={s.count.decimals ?? 0} prefix={s.count.prefix} suffix={s.count.suffix} />
            ) : (
              s.value
            )}
          </div>
          {s.sub && <div className="stat-sub">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* ── probability bar (fills from 0 when scrolled into view) ── */
export function Bar({ pct, color, width = 110 }: { pct: number; color: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const w = inView ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div ref={ref} className="flex items-center gap-[7px]" style={{ minWidth: width }}>
      <div className="track">
        <div className="fill" style={{ width: `${w}%`, background: color }} />
      </div>
    </div>
  );
}

/* ── split fill that grows from 0 on view (for two-sided prob bars) ── */
export function SplitBar({ awayPct, className = "" }: { awayPct: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const a = inView ? Math.max(0, Math.min(100, awayPct)) : 0;
  return (
    <div ref={ref} className={`flex h-1 w-full overflow-hidden rounded-[2px] bg-border ${className}`}>
      <div className="h-full bg-accent-3 transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ width: `${a}%` }} />
      <div className="h-full flex-1 bg-accent" />
    </div>
  );
}

/* ── skeletons ── */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}
export function TableSkeleton({ rows = 10, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div className="card" aria-busy="true" aria-label="Loading">
      <div className="card-header">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-4 w-10" />
      </div>
      <div className="p-3">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-3 border-b border-border/60 py-[10px] last:border-none">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={`h-3 ${c === 1 ? "w-32 flex-none" : "flex-1"}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
export function CardListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card flex items-center gap-3 p-4">
          <Skeleton className="h-[52px] w-[52px] rounded-full" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mx-auto h-3 w-28" />
          <Skeleton className="ml-auto h-7 w-24" />
          <Skeleton className="h-[52px] w-[52px] rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ── empty / error states ── */
export function Loading({ msg = "Loading…" }: { msg?: string }) {
  return (
    <div className="state-msg" role="status">
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

/* ── accessible, sortable table ── */
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
            {cols.map((c) => {
              const active = sort === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  tabIndex={0}
                  role="columnheader"
                  aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => click(c.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      click(c.key);
                    }
                  }}
                  className={c.num ? "text-right" : ""}
                >
                  {c.label}
                  {active && <span aria-hidden className="text-accent"> {dir === "asc" ? "↑" : "↓"}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={rowKey(row, i)} className="reveal" style={{ animationDelay: `${Math.min(i * 16, 320)}ms` }}>
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
