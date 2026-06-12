"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { WinnerPrediction, OddsGame } from "@/lib/types";
import { logoSrc, normAbbr } from "@/lib/teams";
import { confTone, num, odds as fmtOdds, dash } from "@/lib/format";
import { StatStrip, Loading, Empty, type Stat } from "@/components/ui";

function Logo({ team, side }: { team: string; side: "away" | "home" }) {
  const src = logoSrc(team);
  const color = side === "away" ? "text-accent-3" : "text-accent";
  if (!src)
    return <div className={`flex h-[52px] w-[52px] items-center justify-center font-display text-[0.8rem] ${color}`}>{team}</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={team}
      className="h-[52px] w-[52px] flex-shrink-0 object-contain brightness-110 drop-shadow-[0_0_6px_rgba(255,255,255,0.06)]"
      onError={(e) => ((e.currentTarget.style.display = "none"))}
    />
  );
}

function GameCard({ g, oddsMap, idx }: { g: WinnerPrediction; oddsMap: Map<string, OddsGame>; idx: number }) {
  const tone = confTone(g.confidence);
  const o = oddsMap.get(`${normAbbr(g.away)}@${normAbbr(g.home)}`);
  const aml = o?.h2h?.away_ml ?? null;
  const hml = o?.h2h?.home_ml ?? null;

  return (
    <div
      className="reveal group overflow-hidden rounded-[4px] border border-border bg-surface shadow-[var(--shadow-card)] transition-all duration-200 hover:-translate-y-px hover:border-accent/30 hover:shadow-[0_10px_30px_-14px_rgba(0,229,160,0.35)]"
      style={{ animationDelay: `${Math.min(idx * 45, 400)}ms` }}
    >
      <div className="flex items-center gap-[10px] px-4 pb-[10px] pt-[14px]">
        {/* away */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Logo team={g.away} side="away" />
          <div className="flex min-w-0 flex-col gap-px">
            <span className="font-display text-[1.7rem] leading-none tracking-[0.05em] text-accent-3">{g.away}</span>
            <span className="mono truncate text-[0.52rem] uppercase tracking-[0.1em] text-muted">{dash(g.away_sp)}</span>
            <span className="mono text-[0.72rem] font-semibold text-accent-3">{num(g.away_prob, 0)}%</span>
          </div>
        </div>

        {/* middle */}
        <div className="flex w-[104px] flex-shrink-0 flex-col items-center gap-[6px]">
          <div className="flex h-1 w-full overflow-hidden rounded-[2px] bg-border">
            <div className="h-full bg-accent-3" style={{ width: `${g.away_prob}%` }} />
            <div className="h-full flex-1 bg-accent" />
          </div>
          <div className="mono text-[0.62rem] text-muted-2">@</div>
          <span className={`pill ${tone.cls} text-[0.62rem]`}>
            {tone.arrow} {g.pick} {num(g.confidence, 0)}%
          </span>
        </div>

        {/* home */}
        <div className="flex min-w-0 flex-1 flex-row-reverse items-center gap-3">
          <Logo team={g.home} side="home" />
          <div className="flex min-w-0 flex-col items-end gap-px">
            <span className="font-display text-[1.7rem] leading-none tracking-[0.05em] text-accent">{g.home}</span>
            <span className="mono truncate text-[0.52rem] uppercase tracking-[0.1em] text-muted">{dash(g.home_sp)}</span>
            <span className="mono text-[0.72rem] font-semibold text-accent">{num(g.home_prob, 0)}%</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 pb-[10px] pt-2">
        <span className="mono text-[0.68rem] text-muted-2">
          Proj Total <b className="text-text">{num(g.proj_total, 1)}</b>
        </span>
        {(aml != null || hml != null) && (
          <span className="mono text-[0.68rem] text-muted-2">
            ML <b className="text-accent-3">{fmtOdds(aml)}</b> / <b className="text-accent">{fmtOdds(hml)}</b>
          </span>
        )}
        {g.edge != null && (
          <span className={`mono ml-auto text-[0.68rem] font-semibold ${g.edge > 0 ? "text-win" : "text-muted"}`}>
            {g.edge > 0 ? `+EV ${num(g.edge * 100, 1)}%` : "—"}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Winners({ date, isToday }: { date: string; isToday: boolean }) {
  const [games, setGames] = useState<WinnerPrediction[] | null>(null);
  const [oddsMap, setOddsMap] = useState<Map<string, OddsGame>>(new Map());

  useEffect(() => {
    let alive = true;
    setGames(null);
    (async () => {
      const [w, o] = await Promise.all([api.winners(isToday ? undefined : date), api.odds(isToday ? "today" : date)]);
      if (!alive) return;
      const m = new Map<string, OddsGame>();
      for (const og of o.games) {
        m.set(`${normAbbr(og.away)}@${normAbbr(og.home)}`, og);
        m.set(`${normAbbr(og.home)}@${normAbbr(og.away)}`, og);
      }
      setOddsMap(m);
      setGames(w);
    })();
    return () => {
      alive = false;
    };
  }, [date, isToday]);

  const stats: Stat[] = useMemo(() => {
    if (!games || !games.length) return [];
    const top = [...games].sort((a, b) => b.confidence - a.confidence)[0];
    const strong = games.filter((g) => g.confidence >= 62).length;
    const ev = games.filter((g) => (g.edge ?? 0) > 0).length;
    return [
      { label: "Games", value: String(games.length), sub: "on the slate" },
      { label: "Top Pick", value: top.pick, sub: `${top.away} @ ${top.home} · ${num(top.confidence, 0)}%`, tone: "var(--color-accent)" },
      { label: "Strong (≥62%)", value: String(strong), sub: "high-confidence", tone: "var(--color-accent-3)" },
      { label: "+EV Edges", value: String(ev), sub: "vs market", tone: "var(--color-push)" },
    ];
  }, [games]);

  if (games === null) return <Loading msg="Loading predictions…" />;
  if (!games.length) return <Empty icon="⬡" msg="No game predictions for this date." />;

  return (
    <>
      <StatStrip stats={stats} />
      <div className="flex flex-col gap-2">
        {games.map((g, i) => (
          <GameCard key={`${g.away}@${g.home}-${g.game_number}`} g={g} oddsMap={oddsMap} idx={i} />
        ))}
      </div>
    </>
  );
}
