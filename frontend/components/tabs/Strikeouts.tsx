"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { StrikeoutPrediction, LiveStrikeouts } from "@/lib/types";
import { num, pct, dash } from "@/lib/format";
import { StatStrip, Loading, Empty, SortTable, type Col, type Stat } from "@/components/ui";

const WEIGHTS = [
  { label: "Zone Contact% (60%)", note: "R²=0.695", color: "var(--color-accent)", w: 50 },
  { label: "Whiff% Matchup (25%)", note: "per pitch type", color: "var(--color-accent-3)", w: 26 },
  { label: "Bat Speed → Whiff", note: "R²=0.331", color: "var(--color-push)", w: 24 },
  { label: "Chase% (15%)", note: "R²=0.060", color: "var(--color-muted-2)", w: 8 },
];

export default function Strikeouts({ date, isToday }: { date: string; isToday: boolean }) {
  const [rows, setRows] = useState<StrikeoutPrediction[] | null>(null);
  const [live, setLive] = useState<LiveStrikeouts>({});

  useEffect(() => {
    let alive = true;
    setRows(null);
    (async () => {
      const [r, l] = await Promise.all([api.strikeouts(isToday ? undefined : date), api.liveStrikeouts(date)]);
      if (!alive) return;
      setLive(l);
      setRows(r);
    })();
    return () => {
      alive = false;
    };
  }, [date, isToday]);

  const stats: Stat[] = useMemo(() => {
    if (!rows || !rows.length) return [];
    const sorted = [...rows].sort((a, b) => b.pred_k - a.pred_k);
    const strong = rows.filter((r) => r.pred_k >= 8).length;
    return [
      { label: "Pitchers", value: String(rows.length), sub: "starting today" },
      { label: "Top Projection", value: num(sorted[0].pred_k, 1), sub: `${sorted[0].pitcher}`, tone: "var(--color-accent-2)" },
      { label: "8+ K Plays", value: String(strong), sub: "high strikeout", tone: "var(--color-accent)" },
      { label: "#2 Projection", value: sorted[1] ? num(sorted[1].pred_k, 1) : "—", sub: sorted[1]?.pitcher || "—", tone: "var(--color-accent-3)" },
    ];
  }, [rows]);

  const cols: Col<StrikeoutPrediction>[] = [
    { key: "_i", label: "#", render: (_r, i) => <span className="font-display text-[1.05rem] text-muted">{i + 1}</span>, sortVal: () => 0 },
    { key: "pitcher", label: "Pitcher", render: (r) => <span className="font-medium">{r.pitcher}</span> },
    { key: "team", label: "Team", className: "mono text-muted-2" },
    { key: "opponent", label: "Opp", className: "mono text-muted-2" },
    {
      key: "pred_k",
      label: "Proj K's",
      num: true,
      render: (r) => <span className="font-display text-[1.1rem] text-accent-2">{num(r.pred_k, 1)}</span>,
    },
    { key: "dk_line", label: "DK Line", num: true, render: (r) => <span className="text-push">{r.dk_line != null ? num(r.dk_line, 1) : "—"}</span> },
    {
      key: "_actual",
      label: "Actual",
      num: true,
      sortVal: (r) => live[r.pitcher]?.ks ?? -1,
      render: (r) => {
        const a = live[r.pitcher];
        if (!a) return <span className="text-muted">—</span>;
        const beat = r.dk_line != null && a.ks > r.dk_line;
        return <span className={`font-display text-[1.05rem] ${beat ? "text-win" : "text-text"}`}>{a.ks}</span>;
      },
    },
    { key: "k_pct", label: "Season K%", num: true, render: (r) => pct(r.k_pct) },
    { key: "whiff_pct", label: "Whiff%", num: true, render: (r) => pct(r.whiff_pct) },
    { key: "chase_pct", label: "Chase%", num: true, render: (r) => pct(r.chase_pct) },
    { key: "iz_contact_pct", label: "IZ-Con%", num: true, render: (r) => pct(r.iz_contact_pct) },
    { key: "lineup_bat_speed", label: "Bat Spd", num: true, render: (r) => num(r.lineup_bat_speed) },
    { key: "exp_k_rate", label: "Exp K%", num: true, render: (r) => pct(r.exp_k_rate) },
    { key: "lineup_vuln", label: "L-Vuln", num: true, render: (r) => <span className="text-muted-2">{dash(r.lineup_vuln != null ? num(r.lineup_vuln, 0) : null)}</span> },
  ];

  return (
    <>
      <div className="card mb-[14px]">
        <div className="card-header">
          <span className="card-title">Hitter K-Vulnerability Weights</span>
          <span className="badge badge-accent">Empirical Correlations</span>
        </div>
        <div className="flex flex-wrap gap-px border-b border-border bg-border">
          {WEIGHTS.map((w) => (
            <div key={w.label} className="flex flex-1 items-center gap-[7px] bg-accent/[0.02] px-3 py-[7px]">
              <div className="h-[3px] flex-shrink-0 rounded-[2px]" style={{ width: w.w, background: w.color }} />
              <span className="mono text-[0.58rem] tracking-[0.07em] text-muted-2">{w.label}</span>
              <span className="mono ml-auto text-[0.63rem] font-medium" style={{ color: w.color }}>
                {w.note}
              </span>
            </div>
          ))}
        </div>
      </div>

      {rows === null ? (
        <Loading msg="Loading strikeout projections…" />
      ) : !rows.length ? (
        <Empty icon="⚡" msg="No strikeout predictions for this date." />
      ) : (
        <>
          <StatStrip stats={stats} />
          <div className="card">
            <div className="card-header">
              <span className="card-title">Pitcher Strikeout Predictions</span>
              <span className="badge badge-blue">{rows.length}</span>
            </div>
            <SortTable rows={rows} cols={cols} initialSort="pred_k" rowKey={(r) => r.pitcher} />
          </div>
        </>
      )}
    </>
  );
}
