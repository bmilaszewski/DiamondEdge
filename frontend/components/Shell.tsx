"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = { label: string; icon: string; href: string; tab?: string };

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Predictions",
    items: [
      { label: "Game Winners", icon: "⬡", href: "/?tab=winners", tab: "winners" },
      { label: "Strikeouts", icon: "⚡", href: "/?tab=strikeouts", tab: "strikeouts" },
      { label: "Home Runs", icon: "◉", href: "/?tab=homeruns", tab: "homeruns" },
    ],
  },
  {
    title: "Leaderboards",
    items: [
      { label: "Hitters", icon: "◈", href: "/?tab=hitters", tab: "hitters" },
      { label: "Pitchers", icon: "◎", href: "/?tab=pitchers", tab: "pitchers" },
    ],
  },
  {
    title: "More",
    items: [
      { label: "Dashboard", icon: "▦", href: "/dashboard" },
      { label: "Pick Detail", icon: "❖", href: "/predictions" },
    ],
  },
];

function Sidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab") || "winners";

  const isActive = (it: NavItem) => {
    if (it.tab) return pathname === "/" && tab === it.tab;
    return pathname === it.href;
  };

  return (
    <aside className="flex w-[212px] min-w-[212px] flex-col border-r border-border bg-surface/95 z-10">
      <div className="border-b border-border px-[18px] pb-4 pt-[22px]">
        <div className="font-display text-[1.7rem] leading-none tracking-[0.07em] text-text">
          Diamond<span className="text-accent drop-shadow-[0_0_12px_rgba(0,229,160,0.5)]">Edge</span>
        </div>
        <div className="mono mt-1 text-[0.6rem] uppercase tracking-[0.15em] text-muted">MLB · Analytics</div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {SECTIONS.map((sec) => (
          <div key={sec.title}>
            <div className="mono px-[18px] pb-1 pt-3 text-[0.58rem] uppercase tracking-[0.18em] text-muted">
              {sec.title}
            </div>
            {sec.items.map((it) => {
              const active = isActive(it);
              return (
                <Link
                  key={it.label}
                  href={it.href}
                  className={[
                    "group flex items-center gap-[10px] border-l-2 px-[18px] py-2 text-[0.8rem] font-medium transition-all",
                    active
                      ? "border-accent bg-accent/[0.06] text-accent"
                      : "border-transparent text-muted-2 hover:bg-surface-2 hover:text-text",
                  ].join(" ")}
                >
                  <span className="w-[18px] flex-shrink-0 text-center text-[0.9rem] transition-transform group-hover:translate-x-[1px]">
                    {it.icon}
                  </span>
                  {it.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mono border-t border-border px-[18px] py-3 text-[0.62rem] leading-[1.7] text-muted">
        <div>Live data · ESPN · OddsAPI</div>
        <div className="text-muted-2">Updated every 30 min</div>
      </div>
    </aside>
  );
}

export default function Shell({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative z-[1] flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] min-h-[52px] items-center justify-between gap-3 border-b border-border bg-gradient-to-b from-surface-2 to-surface px-[22px]">
          <div className="flex min-w-0 items-center gap-3">
            <span className="font-display whitespace-nowrap text-[1.1rem] tracking-[0.07em] text-text">{title}</span>
            {count != null && (
              <span className="mono whitespace-nowrap rounded-[2px] border border-border bg-surface-2 px-[10px] py-[3px] text-[0.65rem] tracking-[0.1em] text-muted-2">
                {count}
              </span>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        </header>
        <main className="flex-1 overflow-y-auto px-[22px] pb-10 pt-5">{children}</main>
      </div>
    </div>
  );
}
