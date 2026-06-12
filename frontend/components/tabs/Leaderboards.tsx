"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { HitterLeaderRow, PitcherLeaderRow } from "@/lib/types";
import { num, pct, dash } from "@/lib/format";
import { Loading, Empty, SortTable, type Col } from "@/components/ui";

const rank = (i: number) => <span className="font-display text-[1.05rem] text-muted">{i + 1}</span>;

/* ── Hitters ── */
const HITTER_WINDOWS = [
  { key: "10", label: "Last 10" },
  { key: "20", label: "Last 20" },
  { key: "season", label: "Season" },
];

export function Hitters() {
  const [window, setWindow] = useState("10");
  const [rows, setRows] = useState<HitterLeaderRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.hitters({ window, stat: "ops", limit: 60 }).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [window]);

  const cols: Col<HitterLeaderRow>[] = [
    { key: "_i", label: "#", render: (_r, i) => rank(i), sortVal: () => 0 },
    { key: "name", label: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "team", label: "Team", className: "mono text-muted-2" },
    { key: "position", label: "Pos", className: "mono text-muted-2" },
    { key: "ops", label: "OPS", num: true, render: (r) => <span className="font-display text-[1.05rem] text-accent">{num(r.ops, 3)}</span> },
    { key: "avg", label: "AVG", num: true, render: (r) => num(r.avg, 3) },
    { key: "obp", label: "OBP", num: true, render: (r) => num(r.obp, 3) },
    { key: "slg", label: "SLG", num: true, render: (r) => num(r.slg, 3) },
    { key: "home_runs", label: "HR", num: true, render: (r) => <span className="text-accent-2">{r.home_runs}</span> },
    { key: "strikeouts", label: "K", num: true },
    { key: "walks", label: "BB", num: true },
    { key: "iso", label: "ISO", num: true, render: (r) => num(r.iso, 3) },
    { key: "exit_velocity_avg", label: "EV", num: true, render: (r) => num(r.exit_velocity_avg) },
    { key: "at_bats", label: "AB", num: true },
  ];

  return (
    <>
      <div className="mb-[14px] flex flex-wrap items-center gap-2">
        {HITTER_WINDOWS.map((w) => (
          <button key={w.key} className="chip" data-active={window === w.key} onClick={() => setWindow(w.key)}>
            {w.label}
          </button>
        ))}
      </div>
      {rows === null ? (
        <Loading msg="Loading hitters…" />
      ) : !rows.length ? (
        <Empty icon="◈" msg="No hitter data." />
      ) : (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Hitter Leaderboard</span>
            <span className="badge badge-blue">{rows.length}</span>
          </div>
          <SortTable rows={rows} cols={cols} initialSort="ops" rowKey={(r) => String(r.mlb_id)} />
        </div>
      )}
    </>
  );
}

/* ── Pitchers ── */
const PITCHER_STATS = [
  { key: "k_percent", label: "K%" },
  { key: "era", label: "ERA" },
  { key: "whiff_percent", label: "Whiff%" },
  { key: "xwoba", label: "xwOBA" },
];

export function Pitchers() {
  const [stat, setStat] = useState("k_percent");
  const [rows, setRows] = useState<PitcherLeaderRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api.pitchers(stat, 60).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [stat]);

  const cols: Col<PitcherLeaderRow>[] = [
    { key: "_i", label: "#", render: (_r, i) => rank(i), sortVal: () => 0 },
    { key: "name", label: "Pitcher", render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "team", label: "Team", render: (r) => dash(r.team), className: "mono text-muted-2" },
    { key: "pitch_hand", label: "Hand", render: (r) => dash(r.pitch_hand), className: "mono text-muted-2" },
    { key: "games", label: "Usage", num: true, render: (r) => <span className="mono text-[0.72rem] text-muted-2">{r.games}G · {num(r.innings_pitched, 0)}IP</span> },
    { key: "k_percent", label: "K%", num: true, render: (r) => <span className="font-display text-[1.05rem] text-accent">{pct(r.k_percent)}</span> },
    { key: "era", label: "ERA", num: true, render: (r) => num(r.era, 2) },
    { key: "bb_percent", label: "BB%", num: true, render: (r) => pct(r.bb_percent) },
    { key: "whiff_percent", label: "Whiff%", num: true, render: (r) => pct(r.whiff_percent) },
    { key: "oz_swing_percent", label: "Chase%", num: true, render: (r) => pct(r.oz_swing_percent) },
    { key: "iz_contact_percent", label: "IZ-Con%", num: true, render: (r) => pct(r.iz_contact_percent) },
    { key: "xwoba", label: "xwOBA", num: true, render: (r) => num(r.xwoba, 3) },
    { key: "fastball_velo", label: "FB Velo", num: true, render: (r) => num(r.fastball_velo) },
  ];

  return (
    <>
      <div className="mb-[14px] flex flex-wrap items-center gap-2">
        {PITCHER_STATS.map((s) => (
          <button key={s.key} className="chip" data-active={stat === s.key} onClick={() => setStat(s.key)}>
            Sort: {s.label}
          </button>
        ))}
      </div>
      {rows === null ? (
        <Loading msg="Loading pitchers…" />
      ) : !rows.length ? (
        <Empty icon="◎" msg="No pitcher data." />
      ) : (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Pitcher Leaderboard</span>
            <span className="badge badge-blue">{rows.length}</span>
          </div>
          <SortTable rows={rows} cols={cols} initialSort={stat} rowKey={(r) => String(r.mlb_id)} />
        </div>
      )}
    </>
  );
}
