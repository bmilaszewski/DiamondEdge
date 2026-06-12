"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import Shell from "@/components/Shell";
import { DateNav } from "@/components/ui";
import { etTodayISO, shiftISO, prettyDate } from "@/lib/format";
import Winners from "@/components/tabs/Winners";
import Strikeouts from "@/components/tabs/Strikeouts";
import Homeruns from "@/components/tabs/Homeruns";
import { Hitters, Pitchers } from "@/components/tabs/Leaderboards";

const TABS = [
  { key: "winners", label: "Winners", icon: "⬡", title: "Game Winner Predictions", dated: true },
  { key: "strikeouts", label: "Strikeouts", icon: "⚡", title: "Strikeout Predictions", dated: true },
  { key: "homeruns", label: "Home Runs", icon: "◉", title: "Home Run Predictions", dated: true },
  { key: "hitters", label: "Hitters", icon: "◈", title: "Hitter Leaderboard", dated: false },
  { key: "pitchers", label: "Pitchers", icon: "◎", title: "Pitcher Leaderboard", dated: false },
] as const;

export default function HubClient() {
  const router = useRouter();
  const params = useSearchParams();
  const tabKey = (params.get("tab") || "winners") as (typeof TABS)[number]["key"];
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0];

  const today = etTodayISO();
  const [date, setDate] = useState(today);
  const isToday = date >= today;

  const setTab = (k: string) => router.replace(`/?tab=${k}`, { scroll: false });
  const clampNext = (d: string) => (d > today ? today : d);

  return (
    <Shell
      title={tab.title}
      count={tab.dated ? prettyDate(date) : undefined}
      actions={
        <>
          {tab.dated && (
            <DateNav
              date={date}
              label={isToday ? "TODAY" : prettyDate(date)}
              isToday={isToday}
              onPrev={() => setDate((d) => shiftISO(d, -1))}
              onNext={() => setDate((d) => clampNext(shiftISO(d, 1)))}
              onPick={(v) => setDate(clampNext(v))}
            />
          )}
        </>
      }
    >
      {/* tab bar */}
      <div className="mb-[18px] flex border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              "mono -mb-px whitespace-nowrap border-b-2 px-5 py-[9px] text-[0.7rem] uppercase tracking-[0.1em] transition-colors",
              t.key === tab.key ? "border-accent text-accent" : "border-transparent text-muted hover:text-muted-2",
            ].join(" ")}
          >
            <span className="mr-[6px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* panel */}
      <div key={tab.key} className="animate-[fadeIn_0.2s_ease]">
        {tab.key === "winners" && <Winners date={date} isToday={isToday} />}
        {tab.key === "strikeouts" && <Strikeouts date={date} isToday={isToday} />}
        {tab.key === "homeruns" && <Homeruns date={date} isToday={isToday} />}
        {tab.key === "hitters" && <Hitters />}
        {tab.key === "pitchers" && <Pitchers />}
      </div>
    </Shell>
  );
}
