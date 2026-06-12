// Small formatting helpers shared across views.

// SQLite/Express can hand back numbers as strings ("4.0"), so coerce defensively.
const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const pct = (v: number | string | null | undefined, d = 1): string => {
  const n = toNum(v);
  return n == null ? "—" : `${n.toFixed(d)}%`;
};

export const num = (v: number | string | null | undefined, d = 1): string => {
  const n = toNum(v);
  return n == null ? "—" : n.toFixed(d);
};

export const dash = (v: unknown): string =>
  v == null || v === "" ? "—" : String(v);

// American odds formatting: +150 / -120
export const odds = (v: number | null | undefined): string => {
  if (v == null || Number.isNaN(v)) return "—";
  return v > 0 ? `+${v}` : `${v}`;
};

// Confidence → pill class + arrow glyph, matching legacy thresholds (62 / 55).
export const confTone = (c: number): { cls: string; arrow: string } => {
  if (c >= 62) return { cls: "pill-green", arrow: "▲" };
  if (c >= 55) return { cls: "pill-yellow", arrow: "–" };
  return { cls: "pill-blue", arrow: "▽" };
};

// ── Eastern-time date helpers (the backend keys everything to America/New_York) ──
export function etTodayISO(): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(new Date()); // YYYY-MM-DD
}

export function shiftISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
