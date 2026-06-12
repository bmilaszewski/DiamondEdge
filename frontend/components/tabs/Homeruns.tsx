"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { HomerunGame, HRBatter, LiveHomeruns } from "@/lib/types";
import { num, dash, odds as fmtOdds } from "@/lib/format";
import { StatStrip, CardListSkeleton, Empty, type Stat } from "@/components/ui";

function probColor(p: number) {
  if (p >= 15) return "var(--color-accent-2)";
  if (p >= 10) return "var(--color-push)";
  return "var(--color-muted-2)";
}

function BatterRow({ b, live }: { b: HRBatter; live: LiveHomeruns }) {
  const hit = (live[b.batter]?.hrs ?? 0) > 0;
  return (
    <div className={`flex items-center gap-2 rounded-[2px] px-2 py-[5px] ${hit ? "bg-accent/[0.08]" : ""}`}>
      <span className="mono w-4 flex-shrink-0 text-[0.62rem] text-muted">{b.batting_order}</span>
      <span className="min-w-0 flex-1 truncate text-[0.78rem]">{b.batter}</span>
      {hit && <span className="mono flex-shrink-0 rounded-[2px] border border-win/40 bg-win/20 px-[5px] text-[0.55rem] text-win">HR ×{live[b.batter].hrs}</span>}
      {b.dk_hr_odds != null && <span className="mono flex-shrink-0 text-[0.62rem] text-muted-2">{fmtOdds(b.dk_hr_odds)}</span>}
      <span className="font-display flex-shrink-0 text-[1rem]" style={{ color: probColor(b.hr_prob_game), minWidth: 38, textAlign: "right" }}>
        {num(b.hr_prob_game, 1)}%
      </span>
    </div>
  );
}

function GameCard({ g, live, idx }: { g: HomerunGame; live: LiveHomeruns; idx: number }) {
  const away = [...g.away_lineup].sort((a, b) => b.hr_prob_game - a.hr_prob_game);
  const home = [...g.home_lineup].sort((a, b) => b.hr_prob_game - a.hr_prob_game);
  return (
    <div className="reveal card" style={{ animationDelay: `${Math.min(idx * 60, 400)}ms` }}>
      <div className="card-header">
        <span className="card-title">
          <span className="text-accent-3">{g.away}</span> <span className="text-muted">@</span> <span className="text-accent">{g.home}</span>
        </span>
        <span className="mono text-[0.6rem] text-muted-2">
          {dash(g.weather_cond)} · {g.temp_f != null ? `${g.temp_f}°F` : "—"} · PF {num(g.park_factor, 2)}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-px bg-border md:grid-cols-2">
        <div className="bg-surface p-2">
          <div className="mono mb-1 px-2 text-[0.55rem] uppercase tracking-[0.12em] text-accent-3">{g.away} · vs {dash(g.home_sp)}</div>
          {away.map((b) => (
            <BatterRow key={b.batter} b={b} live={live} />
          ))}
        </div>
        <div className="bg-surface p-2">
          <div className="mono mb-1 px-2 text-[0.55rem] uppercase tracking-[0.12em] text-accent">{g.home} · vs {dash(g.away_sp)}</div>
          {home.map((b) => (
            <BatterRow key={b.batter} b={b} live={live} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Homeruns({ date, isToday }: { date: string; isToday: boolean }) {
  const [games, setGames] = useState<HomerunGame[] | null>(null);
  const [live, setLive] = useState<LiveHomeruns>({});

  useEffect(() => {
    let alive = true;
    setGames(null);
    (async () => {
      const [g, l] = await Promise.all([api.homeruns(isToday ? undefined : date), api.liveHomeruns(date)]);
      if (!alive) return;
      setLive(l);
      setGames(g);
    })();
    return () => {
      alive = false;
    };
  }, [date, isToday]);

  const stats: Stat[] = useMemo(() => {
    if (!games || !games.length) return [];
    const all = games.flatMap((g) =>
      [...g.away_lineup, ...g.home_lineup].map((b) => ({ b, g })),
    );
    all.sort((a, b) => b.b.hr_prob_game - a.b.hr_prob_game);
    const strong = all.filter((x) => x.b.hr_prob_game >= 15).length;
    const top = all[0];
    return [
      { label: "Games", value: String(games.length), sub: "with lineups", count: { to: games.length } },
      { label: "Top HR Bat", value: top ? `${num(top.b.hr_prob_game, 1)}%` : "—", sub: top?.b.batter, tone: "var(--color-accent-2)", count: top ? { to: top.b.hr_prob_game, decimals: 1, suffix: "%" } : undefined },
      { label: "15%+ Plays", value: String(strong), sub: "elite HR odds", tone: "var(--color-push)", count: { to: strong } },
      { label: "#2 HR Bat", value: all[1] ? `${num(all[1].b.hr_prob_game, 1)}%` : "—", sub: all[1]?.b.batter, tone: "var(--color-accent-3)", count: all[1] ? { to: all[1].b.hr_prob_game, decimals: 1, suffix: "%" } : undefined },
    ];
  }, [games]);

  if (games === null) return <CardListSkeleton count={4} />;
  if (!games.length) return <Empty icon="◉" msg="No home-run predictions for this date." />;

  return (
    <>
      <StatStrip stats={stats} />
      <div className="flex flex-col gap-4">
        {games.map((g, i) => (
          <GameCard key={`${g.away}@${g.home}`} g={g} live={live} idx={i} />
        ))}
      </div>
    </>
  );
}
