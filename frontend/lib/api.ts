// Typed fetch client. All requests are same-origin /api/* and proxied to the
// Express backend by next.config.mjs rewrites.

import type {
  WinnerPrediction,
  StrikeoutPrediction,
  HomerunGame,
  OddsResponse,
  HistoricalResponse,
  PitcherLeaderRow,
  HitterLeaderRow,
  UnitsWeeklyResponse,
  DataVersion,
  LiveStrikeouts,
  LiveHomeruns,
} from "./types";

async function getJSON<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

const q = (date?: string) => (date ? `?date=${encodeURIComponent(date)}` : "");

export const api = {
  winners: (date?: string) =>
    getJSON<WinnerPrediction[]>(`/api/predictions/winners${q(date)}`, []),

  strikeouts: (date?: string) =>
    getJSON<StrikeoutPrediction[]>(`/api/predictions/strikeouts${q(date)}`, []),

  homeruns: (date?: string) =>
    getJSON<HomerunGame[]>(`/api/predictions/homeruns${q(date)}`, []),

  odds: (date: string) =>
    getJSON<OddsResponse>(`/api/odds/${encodeURIComponent(date)}`, { date, games: [] }),

  historical: (date: string) =>
    getJSON<HistoricalResponse>(`/api/historical/${encodeURIComponent(date)}`, { date, games: [] }),

  liveStrikeouts: (date: string) =>
    getJSON<LiveStrikeouts>(`/api/live/strikeouts?date=${encodeURIComponent(date)}`, {}),

  liveHomeruns: (date: string) =>
    getJSON<LiveHomeruns>(`/api/live/homeruns?date=${encodeURIComponent(date)}`, {}),

  pitchers: (stat: string, limit = 60) =>
    getJSON<PitcherLeaderRow[]>(
      `/api/pitchers/leaderboard?stat=${encodeURIComponent(stat)}&min_games=3&limit=${limit}`,
      [],
    ),

  hitters: (params: { window: string | number; stat: string; limit?: number }) => {
    const { window, stat, limit = 60 } = params;
    const base = window === "season" ? "/api/leaderboard/season" : "/api/leaderboard";
    const win = window === "season" ? "" : `window=${window}&`;
    return getJSON<HitterLeaderRow[]>(`${base}?${win}stat=${encodeURIComponent(stat)}&limit=${limit}`, []);
  },

  unitsWeekly: (date?: string) =>
    getJSON<UnitsWeeklyResponse>(`/api/units/weekly${q(date)}`, {
      week_start: "",
      week_end: "",
      all: null,
      ev: null,
    }),

  dataVersion: () => getJSON<DataVersion>("/api/data-version", { lineup: 0, predictions: 0 }),
};
