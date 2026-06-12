"use client";

import { useEffect, useMemo, useState } from "react";
import Shell from "@/components/Shell";
import { StatStrip, CardListSkeleton, type Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { WinnerPrediction, StrikeoutPrediction, UnitsWeeklyResponse } from "@/lib/types";
import { num, dash, confTone, prettyDate, etTodayISO } from "@/lib/format";
import { logoSrc } from "@/lib/teams";

export default function DashboardClient() {
  const [winners, setWinners] = useState<WinnerPrediction[] | null>(null);
  const [ks, setKs] = useState<StrikeoutPrediction[]>([]);
  const [week, setWeek] = useState<UnitsWeeklyResponse | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [w, k, u] = await Promise.all([api.winners(), api.strikeouts(), api.unitsWeekly()]);
      if (!alive) return;
      setKs(k);
      setWeek(u);
      setWinners(w);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const stats: Stat[] = useMemo(() => {
    const all = week?.all;
    const ev = week?.ev;
    return [
      { label: "Week Record", value: all ? `${all.wins}-${all.losses}` : "—", sub: "all picks" },
      { label: "Units", value: all ? `${all.units > 0 ? "+" : ""}${num(all.units, 2)}` : "—", sub: "this week", tone: all && all.units >= 0 ? "var(--color-win)" : "var(--color-loss)" },
      { label: "+EV Record", value: ev ? `${ev.wins}-${ev.losses}` : "—", sub: "vs market", tone: "var(--color-accent-3)" },
      { label: "Pending", value: all ? String(all.pending) : "—", sub: "in progress", tone: "var(--color-push)", count: all ? { to: all.pending } : undefined },
    ];
  }, [week]);

  const topPicks = useMemo(() => (winners ? [...winners].sort((a, b) => b.confidence - a.confidence).slice(0, 5) : []), [winners]);
  const topKs = useMemo(() => [...ks].sort((a, b) => b.pred_k - a.pred_k).slice(0, 6), [ks]);

  return (
    <Shell title="Daily Dashboard" count={prettyDate(etTodayISO())}>
      {winners === null ? (
        <CardListSkeleton count={5} />
      ) : (
        <>
          <StatStrip stats={stats} />

          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_320px]">
            {/* games */}
            <div>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="font-display text-[1.2rem] tracking-[0.08em] text-muted-2">Today's Games</h2>
                <span className="mono rounded-full border border-border bg-surface-2 px-2 py-[2px] text-[0.68rem] text-muted-2">{winners.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {winners.map((g, i) => {
                  const tone = confTone(g.confidence);
                  return (
                    <div
                      key={`${g.away}@${g.home}-${g.game_number}`}
                      className="reveal card transition-all hover:-translate-y-px hover:border-accent/30"
                      style={{ animationDelay: `${Math.min(i * 45, 350)}ms` }}
                    >
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 pb-3 pt-4">
                        <div className="flex items-center gap-2">
                          <TeamLogo t={g.away} />
                          <div>
                            <div className="font-display text-[1.4rem] leading-none tracking-[0.05em] text-accent-3">{g.away}</div>
                            <div className="text-[0.72rem] text-muted-2">{dash(g.away_sp)}</div>
                          </div>
                        </div>
                        <span className={`pill ${tone.cls}`}>{tone.arrow} {g.pick} {num(g.confidence, 0)}%</span>
                        <div className="flex flex-row-reverse items-center gap-2 text-right">
                          <TeamLogo t={g.home} />
                          <div>
                            <div className="font-display text-[1.4rem] leading-none tracking-[0.05em] text-accent">{g.home}</div>
                            <div className="text-[0.72rem] text-muted-2">{dash(g.home_sp)}</div>
                          </div>
                        </div>
                      </div>
                      <div className="px-5 pb-4">
                        <div className="mb-[5px] flex justify-between">
                          <span className="font-display text-[1rem] text-accent-3">{num(g.away_prob, 0)}%</span>
                          <span className="font-display text-[1rem] text-accent">{num(g.home_prob, 0)}%</span>
                        </div>
                        <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-border">
                          <div className="h-full bg-accent-3 transition-all duration-700" style={{ width: `${g.away_prob}%` }} />
                          <div className="ml-auto h-full bg-accent transition-all duration-700" style={{ width: `${g.home_prob}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center gap-3 border-t border-border px-5 py-[0.7rem]">
                        <span className="mono text-[0.68rem] text-muted-2">Proj Total <b className="text-text">{num(g.proj_total, 1)}</b></span>
                        <span className="confidence mono ml-auto text-[0.68rem] text-muted">conf {num(g.confidence, 0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* sidebar */}
            <div className="flex flex-col gap-5">
              <div className="card">
                <div className="card-header"><span className="card-title">Top Picks</span></div>
                <div className="px-[1.2rem] py-1">
                  {topPicks.map((p, i) => {
                    const tone = confTone(p.confidence);
                    return (
                      <div key={i} className="flex items-start gap-[0.8rem] border-b border-border py-[0.8rem] last:border-none">
                        <span className="font-display text-[1.1rem] text-muted">{i + 1}</span>
                        <div className="flex-1">
                          <div className="text-[0.8rem] font-semibold">{p.away} @ {p.home}</div>
                          <div className="mono text-[0.68rem] text-muted-2">Pick {p.pick}</div>
                        </div>
                        <span className={`mono text-[0.75rem] font-semibold ${tone.cls === "pill-green" ? "text-win" : tone.cls === "pill-yellow" ? "text-push" : "text-accent-3"}`}>
                          {num(p.confidence, 0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* pitchers */}
          {topKs.length > 0 && (
            <section className="mt-8">
              <div className="mb-3 flex items-center gap-3">
                <h2 className="font-display text-[1.2rem] tracking-[0.08em] text-muted-2">Strikeout Leaders</h2>
              </div>
              <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[4px] border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {topKs.map((p) => (
                  <div key={p.pitcher} className="flex cursor-default flex-col gap-2 bg-surface p-[1.2rem] transition-colors hover:bg-surface-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-[0.9rem] font-semibold leading-tight">{p.pitcher}</div>
                        <div className="mono mt-[2px] text-[0.65rem] text-muted">{p.team} vs {p.opponent}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-display text-[1.5rem] leading-none text-accent-2">{num(p.pred_k, 1)}</div>
                        <div className="mono text-[0.6rem] text-muted">proj K</div>
                      </div>
                    </div>
                    <div className="mono text-[0.65rem] text-muted-2">
                      DK {p.dk_line != null ? num(p.dk_line, 1) : "—"} · Whiff {p.whiff_pct != null ? num(p.whiff_pct, 1) + "%" : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Shell>
  );
}

function TeamLogo({ t }: { t: string }) {
  const src = logoSrc(t);
  if (!src) return <div className="flex h-7 w-7 items-center justify-center font-display text-[0.7rem] text-muted">{t}</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={t} className="h-7 w-7 object-contain" onError={(e) => (e.currentTarget.style.display = "none")} />;
}
