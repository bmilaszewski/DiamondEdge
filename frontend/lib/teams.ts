// Team abbreviation normalization + MLB logo ids (from the legacy frontend).

export const MLB_IDS: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113, CLE: 114,
  COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119, MIA: 146, MIL: 158,
  MIN: 142, NYM: 121, NYY: 147, OAK: 133, PHI: 143, PIT: 134, SD: 135, SF: 137,
  SEA: 136, STL: 138, TB: 139, TEX: 140, TOR: 141, WSH: 120,
};

const ABBR_NORM: Record<string, string> = {
  AZ: "ARI", ATH: "OAK", KCR: "KC", TBR: "TB", SDP: "SD", SFG: "SF", WSN: "WSH",
};

export const normAbbr = (t: string): string => ABBR_NORM[t] || t;

export const logoSrc = (t: string): string => {
  const id = MLB_IDS[normAbbr(t)];
  return id ? `https://www.mlbstatic.com/team-logos/${id}.svg` : "";
};
