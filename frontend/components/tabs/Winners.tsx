"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { WinnerPrediction, OddsGame, HistoricalGame } from "@/lib/types";
import { logoSrc, normAbbr } from "@/lib/teams";
import { confTone, num, signed, odds as fmtOdds, dash } from "@/lib/format";
import { StatStrip, CardListSkeleton, Empty, CountUp, SplitBar, useInView, type Stat } from "@/components/ui";
import { useRef } from "react";

type Live = { state: "in" | "post"; awayScore: number; homeScore: number; detail: string | null };

function resolveLive(g: WinnerPrediction, map: Map<string, HistoricalGame>): Live | null {
  const h = map.get(`${normAbbr(g.away)}@${normAbbr(g.home)}`);
  if (!h || h.game_state === "pre" || h.home_score == null || h.away_score == null) return null;
  return {
    state: h.game_state === "post" ? "post" : "in",
    awayScore: h.away_score,
    homeScore: h.home_score,
    detail: h.game_detail,
  };
}

function Logo({ team, side, size = 52 }: { team: string; side: "away" | "home"; size?: number }) {
  const src = logoSrc(team);
  const color = side === "away" ? "text-accent-3" : "text-accent";
  if (!src)
    return (
      <div className={`flex items-center justify-center font-display ${color}`} style={{ width: size, height: size, fontSize: size * 0.32 }}>
        {team}
      </div>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={team}
      style={{ width: size, height: size }}
      className="flex-shrink-0 object-contain brightness-110 drop-shadow-[0_0_6px_rgba(255,255,255,0.06)]"
      onError={(e) => (e.currentTarget.style.display = "none")}
    />
  );
}

function LiveBadge({ live }: { live: Live }) {
  if (live.state === "post")
    return <span className="mono rounded-[2px] border border-border bg-surface-2 px-[6px] py-[1px] text-[0.55rem] uppercase tracking-[0.1em] text-muted-2">Final</span>;
  return (
    <span className="mono flex items-center gap-[5px] rounded-[4px] border border-[#d97706]/60 bg-[#d97706]/15 px-[6px] py-[1px] text-[0.55rem] font-bold uppercase tracking-[0.1em] text-[#b45309]">
      <span className="inline-block h-[6px] w-[6px] animate-[pulse_1.2s_infinite] rounded-full bg-[#f59e0b]" />
      {dash(live.detail) !== "—" ? live.detail : "Live"}
    </span>
  );
}

/* ── signature hero card for the day's top pick ── */
function HeroCard({ g, live, ml }: { g: WinnerPrediction; live: Live | null; ml: { a: number | null; h: number | null } }) {
  const tone = confTone(g.confidence);
  const pickHome = g.pick === g.home || normAbbr(g.pick) === normAbbr(g.home);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  return (
    <div
      ref={ref}
      className={`reveal relative mb-4 overflow-hidden rounded-[18px] border bg-surface backdrop-blur-2xl shadow-[var(--shadow-card)] ${live?.state === "in" ? "is-live" : "border-accent/30"}`}
    >
      {/* glow */}
      <div className="pointer-events-none absolute inset-0 opacity-80" style={{ background: "radial-gradient(120% 140% at 50% -20%, rgba(6,161,115,0.16), transparent 60%)" }} />
      <div className="relative flex items-center justify-between border-b border-border/70 px-5 py-2">
        <span className="mono text-[0.58rem] font-bold uppercase tracking-[0.22em] text-accent">★ Today&apos;s Top Pick</span>
        {live ? <LiveBadge live={live} /> : <span className="mono text-[0.58rem] uppercase tracking-[0.14em] text-muted">{dash(g.away_sp)} · {dash(g.home_sp)}</span>}
      </div>

      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-6 sm:px-8">
        {/* away */}
        <div className={`flex items-center gap-3 ${pickHome ? "opacity-70" : ""}`}>
          <Logo team={g.away} side="away" size={72} />
          <div className="min-w-0">
            <div className="font-display text-[2.6rem] leading-none tracking-[0.04em] text-accent-3 sm:text-[3.2rem]">{g.away}</div>
            <div className="mono mt-1 text-[0.7rem] text-muted-2">
              {live ? <span className="font-display text-[1.4rem] text-text">{live.awayScore}</span> : <CountUp value={g.away_prob} decimals={0} suffix="% win" />}
            </div>
          </div>
        </div>

        {/* center: confidence */}
        <div className="flex flex-col items-center gap-1 px-2">
          <div className="mono text-[0.55rem] uppercase tracking-[0.18em] text-muted">Pick</div>
          <div className={`font-display text-[1.6rem] leading-none ${pickHome ? "text-accent" : "text-accent-3"}`}>{g.pick}</div>
          <div className="font-display text-[3rem] leading-none text-text">
            <CountUp value={g.confidence} decimals={0} suffix="%" />
          </div>
          <span className={`pill ${tone.cls} mt-1`}>{tone.arrow} {g.edge != null ? `${signed(g.edge)} EV` : "conf"}</span>
        </div>

        {/* home */}
        <div className={`flex flex-row-reverse items-center gap-3 text-right ${!pickHome ? "opacity-70" : ""}`}>
          <Logo team={g.home} side="home" size={72} />
          <div className="min-w-0">
            <div className="font-display text-[2.6rem] leading-none tracking-[0.04em] text-accent sm:text-[3.2rem]">{g.home}</div>
            <div className="mono mt-1 text-[0.7rem] text-muted-2">
              {live ? <span className="font-display text-[1.4rem] text-text">{live.homeScore}</span> : <CountUp value={g.home_prob} decimals={0} suffix="% win" />}
            </div>
          </div>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border/70 px-5 py-2">
        <span className="mono text-[0.68rem] text-muted-2">Proj Total <b className="text-text">{num(g.proj_total, 1)}</b></span>
        {(ml.a != null || ml.h != null) && (
          <span className="mono text-[0.68rem] text-muted-2">
            ML <b className="text-accent-3">{fmtOdds(ml.a)}</b> / <b className="text-accent">{fmtOdds(ml.h)}</b>
          </span>
        )}
        {g.edge != null && (
          <span className={`mono ml-auto text-[0.68rem] font-semibold ${g.edge > 0 ? "text-win" : "text-muted"}`}>
            {g.edge > 0 ? `Model edge ${signed(g.edge)}%` : "No market edge"}
          </span>
        )}
      </div>
    </div>
  );
}

function GameCard({ g, oddsMap, liveMap, idx }: { g: WinnerPrediction; oddsMap: Map<string, OddsGame>; liveMap: Map<string, HistoricalGame>; idx: number }) {
  const tone = confTone(g.confidence);
  const o = oddsMap.get(`${normAbbr(g.away)}@${normAbbr(g.home)}`);
  const aml = o?.h2h?.away_ml ?? null;
  const hml = o?.h2h?.home_ml ?? null;
  const live = resolveLive(g, liveMap);

  return (
    <div
      className={`reveal group overflow-hidden rounded-[14px] border bg-surface backdrop-blur-2xl shadow-[var(--shadow-card)] transition-all duration-200 hover:-translate-y-px hover:shadow-[0_16px_36px_-16px_rgba(6,161,115,0.4)] ${
        live?.state === "in" ? "is-live" : "border-[color:var(--glass-border)] hover:border-accent/40"
      }`}
      style={{ animationDelay: `${Math.min(idx * 45, 400)}ms` }}
    >
      <div className="flex items-center gap-[10px] px-4 pb-[10px] pt-[14px]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Logo team={g.away} side="away" />
          <div className="flex min-w-0 flex-col gap-px">
            <span className="font-display text-[1.7rem] leading-none tracking-[0.05em] text-accent-3">{g.away}</span>
            <span className="mono truncate text-[0.52rem] uppercase tracking-[0.1em] text-muted">{dash(g.away_sp)}</span>
            <span className="mono text-[0.72rem] font-semibold text-accent-3">
              {live ? <span className="font-display text-[1.1rem] text-text">{live.awayScore}</span> : `${num(g.away_prob, 0)}%`}
            </span>
          </div>
        </div>

        <div className="flex w-[104px] flex-shrink-0 flex-col items-center gap-[6px]">
          <SplitBar awayPct={g.away_prob} />
          {live ? <LiveBadge live={live} /> : <div className="mono text-[0.62rem] text-muted-2">@</div>}
          <span className={`pill ${tone.cls} gap-[4px] text-[0.62rem]`}>
            <span>{tone.arrow} {g.pick}</span>
            <CountUp value={g.confidence} decimals={0} suffix="%" />
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-row-reverse items-center gap-3">
          <Logo team={g.home} side="home" />
          <div className="flex min-w-0 flex-col items-end gap-px">
            <span className="font-display text-[1.7rem] leading-none tracking-[0.05em] text-accent">{g.home}</span>
            <span className="mono truncate text-[0.52rem] uppercase tracking-[0.1em] text-muted">{dash(g.home_sp)}</span>
            <span className="mono text-[0.72rem] font-semibold text-accent">
              {live ? <span className="font-display text-[1.1rem] text-text">{live.homeScore}</span> : `${num(g.home_prob, 0)}%`}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 pb-[10px] pt-2">
        <span className="mono text-[0.68rem] text-muted-2">Proj Total <b className="text-text">{num(g.proj_total, 1)}</b></span>
        {(aml != null || hml != null) && (
          <span className="mono text-[0.68rem] text-muted-2">
            ML <b className="text-accent-3">{fmtOdds(aml)}</b> / <b className="text-accent">{fmtOdds(hml)}</b>
          </span>
        )}
        {g.edge != null && (
          <span className={`mono ml-auto text-[0.68rem] font-semibold ${g.edge > 0 ? "text-win" : "text-muted"}`}>
            {g.edge > 0 ? `+EV ${signed(g.edge)}%` : "—"}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Winners({ date, isToday }: { date: string; isToday: boolean }) {
  const [games, setGames] = useState<WinnerPrediction[] | null>(null);
  const [oddsMap, setOddsMap] = useState<Map<string, OddsGame>>(new Map());
  const [liveMap, setLiveMap] = useState<Map<string, HistoricalGame>>(new Map());

  useEffect(() => {
    let alive = true;
    setGames(null);
    (async () => {
      const [w, o, h] = await Promise.all([
        api.winners(isToday ? undefined : date),
        api.odds(isToday ? "today" : date),
        api.historical(date),
      ]);
      if (!alive) return;
      const om = new Map<string, OddsGame>();
      for (const og of o.games) {
        om.set(`${normAbbr(og.away)}@${normAbbr(og.home)}`, og);
        om.set(`${normAbbr(og.home)}@${normAbbr(og.away)}`, og);
      }
      const lm = new Map<string, HistoricalGame>();
      for (const hg of h.games) lm.set(`${normAbbr(hg.away_team)}@${normAbbr(hg.home_team)}`, hg);
      setOddsMap(om);
      setLiveMap(lm);
      setGames(w);
    })();
    return () => {
      alive = false;
    };
  }, [date, isToday]);

  const ranked = useMemo(() => (games ? [...games].sort((a, b) => b.confidence - a.confidence) : []), [games]);

  const stats: Stat[] = useMemo(() => {
    if (!ranked.length) return [];
    const top = ranked[0];
    const strong = ranked.filter((g) => g.confidence >= 62).length;
    const ev = ranked.filter((g) => (g.edge ?? 0) > 0).length;
    return [
      { label: "Games", value: String(ranked.length), sub: "on the slate", count: { to: ranked.length } },
      { label: "Top Pick", value: top.pick, sub: `${top.away} @ ${top.home} · ${num(top.confidence, 0)}%`, tone: "var(--color-accent)" },
      { label: "Strong (≥62%)", value: String(strong), sub: "high-confidence", tone: "var(--color-accent-3)", count: { to: strong } },
      { label: "+EV Edges", value: String(ev), sub: "vs market", tone: "var(--color-push)", count: { to: ev } },
    ];
  }, [ranked]);

  if (games === null) return <CardListSkeleton count={5} />;
  if (!games.length) return <Empty icon="⬡" msg="No game predictions for this date." />;

  const [hero, ...rest] = ranked;
  const heroOdds = oddsMap.get(`${normAbbr(hero.away)}@${normAbbr(hero.home)}`);

  return (
    <>
      <StatStrip stats={stats} />
      <HeroCard g={hero} live={resolveLive(hero, liveMap)} ml={{ a: heroOdds?.h2h?.away_ml ?? null, h: heroOdds?.h2h?.home_ml ?? null }} />
      {rest.length > 0 && (
        <div className="flex flex-col gap-2">
          {rest.map((g, i) => (
            <GameCard key={`${g.away}@${g.home}-${g.game_number}`} g={g} oddsMap={oddsMap} liveMap={liveMap} idx={i} />
          ))}
        </div>
      )}
    </>
  );
}
