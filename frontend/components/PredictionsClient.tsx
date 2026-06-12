"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { DateNav, TableSkeleton, Empty, SortTable, type Col } from "@/components/ui";
import { api } from "@/lib/api";
import type { WinnerPrediction } from "@/lib/types";
import { num, dash, confTone, etTodayISO, shiftISO, prettyDate } from "@/lib/format";

export default function PredictionsClient() {
  const today = etTodayISO();
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<WinnerPrediction[] | null>(null);
  const [modal, setModal] = useState<WinnerPrediction | null>(null);
  const isToday = date >= today;

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.winners(isToday ? undefined : date).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [date, isToday]);

  const clampNext = (d: string) => (d > today ? today : d);

  const cols: Col<WinnerPrediction>[] = [
    { key: "_i", label: "#", render: (_r, i) => <span className="font-display text-[1.05rem] text-muted">{i + 1}</span>, sortVal: () => 0 },
    {
      key: "matchup",
      label: "Matchup",
      sortVal: (r) => `${r.away}@${r.home}`,
      render: (r) => (
        <span className="flex items-center gap-2 font-semibold">
          <span className="mono rounded-[2px] border border-accent-3/20 bg-accent-3/[0.08] px-2 py-[2px] text-[0.7rem] text-accent-3">{r.away}</span>
          <span className="mono text-[0.65rem] text-muted">@</span>
          <span className="mono rounded-[2px] border border-accent/20 bg-accent/[0.08] px-2 py-[2px] text-[0.7rem] text-accent">{r.home}</span>
        </span>
      ),
    },
    { key: "pick", label: "Pick", render: (r) => <span className="font-display text-[1.1rem]">{r.pick}</span> },
    {
      key: "confidence",
      label: "Conf",
      num: true,
      render: (r) => {
        const t = confTone(r.confidence);
        return <span className={`pill ${t.cls}`}>{t.arrow} {num(r.confidence, 1)}%</span>;
      },
    },
    {
      key: "home_prob",
      label: "Win Prob",
      sortVal: (r) => Math.max(r.home_prob, r.away_prob),
      render: (r) => (
        <div className="flex items-center gap-2" style={{ minWidth: 130 }}>
          <div className="track">
            <div className="fill bg-accent" style={{ width: `${Math.max(r.home_prob, r.away_prob)}%` }} />
          </div>
          <span className="mono w-[38px] text-right text-[0.78rem]">{num(Math.max(r.home_prob, r.away_prob), 0)}%</span>
        </div>
      ),
    },
    { key: "proj_total", label: "Proj Total", num: true, render: (r) => num(r.proj_total, 1) },
    {
      key: "_reason",
      label: "Detail",
      sortVal: () => 0,
      render: (r) => (
        <button className="btn" onClick={() => setModal(r)}>
          Why?
        </button>
      ),
    },
  ];

  return (
    <Shell
      title="Pick Detail"
      count={prettyDate(date)}
      actions={
        <DateNav
          date={date}
          label={isToday ? "TODAY" : prettyDate(date)}
          isToday={isToday}
          onPrev={() => setDate((d) => shiftISO(d, -1))}
          onNext={() => setDate((d) => clampNext(shiftISO(d, 1)))}
          onPick={(v) => setDate(clampNext(v))}
        />
      }
    >
      {rows === null ? (
        <TableSkeleton rows={10} cols={7} />
      ) : !rows.length ? (
        <Empty icon="❖" msg="No predictions for this date." />
      ) : (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Game Winner Picks</span>
            <span className="badge badge-blue">{rows.length}</span>
          </div>
          <SortTable rows={rows} cols={cols} initialSort="confidence" rowKey={(r) => `${r.away}@${r.home}-${r.game_number}`} />
        </div>
      )}

      {modal && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/[0.78] backdrop-blur-[6px]"
          onClick={() => setModal(null)}
        >
          <div
            className="relative w-[92%] max-w-[560px] rounded-[4px] border border-border-2 bg-surface px-[30px] pb-7 pt-8 shadow-[var(--shadow-pop)]"
            style={{ animation: "fadeIn 0.15s ease" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="mono absolute right-4 top-[14px] rounded-[2px] px-[6px] py-[2px] text-[1rem] text-muted transition-colors hover:text-text" onClick={() => setModal(null)}>
              ✕
            </button>
            <div className="font-display text-[1.4rem] tracking-[0.06em] text-text">{modal.away} @ {modal.home}</div>
            <div className="mono mb-[22px] flex items-center gap-[14px] text-[0.65rem] uppercase tracking-[0.12em] text-accent">
              <span>Pick {modal.pick}</span>
              <span>·</span>
              <span>{num(modal.confidence, 1)}% conf</span>
              <span>·</span>
              <span>Total {num(modal.proj_total, 1)}</span>
            </div>
            <div className="mono mb-3 border-b border-border pb-2 text-[0.6rem] uppercase tracking-[0.16em] text-muted">Model Rationale</div>
            <p className="text-[0.9rem] leading-[1.8] text-muted-2">
              {dash(modal.reason) !== "—"
                ? modal.reason
                : `Model favors ${modal.pick} at ${num(Math.max(modal.home_prob, modal.away_prob), 1)}% win probability` +
                  (modal.edge != null ? `, with a ${num(modal.edge * 100, 1)}% edge versus the market.` : ".") +
                  " Detailed reasoning is stored for settled games."}
            </p>
          </div>
        </div>
      )}
    </Shell>
  );
}
