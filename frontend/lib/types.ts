// API response types — mirrors the Express endpoints in server.js.

export interface WinnerPrediction {
  away: string;
  home: string;
  pick: string;
  confidence: number;
  game_number: number;
  home_prob: number;
  away_prob: number;
  proj_total: number;
  home_sp: string | null;
  away_sp: string | null;
  model_prob?: number | null;
  vegas_implied?: number | null;
  edge?: number | null;
  same_side?: number | boolean | null;
  reason?: string | null;
}

export interface StrikeoutPrediction {
  pitcher: string;
  team: string;
  opponent: string;
  pred_k: number;
  k_pct: number | null;
  whiff_pct: number | null;
  chase_pct: number | null;
  iz_contact_pct: number | null;
  lineup_iz: number | null;
  lineup_chase: number | null;
  lineup_bat_speed: number | null;
  lineup_vuln: number | null;
  exp_k_rate: number | null;
  data_quality: string | null;
  dk_line: number | null;
  dk_over_odds: number | null;
  dk_under_odds: number | null;
}

export interface HRBatter {
  batting_order: number;
  batter: string;
  hr_prob_game: number;
  hr_prob_pa: number;
  park_factor: number;
  weather_factor: number;
  dk_hr_odds: number | null;
}

export interface HomerunGame {
  home: string;
  away: string;
  park: string;
  park_factor: number;
  temp_f: number | null;
  wind_mph: number | null;
  weather_cond: string;
  away_sp: string | null;
  home_sp: string | null;
  away_lineup: HRBatter[];
  home_lineup: HRBatter[];
}

export interface OddsH2H {
  home_ml: number;
  away_ml: number;
  home_prob: number;
  away_prob: number;
  book_count: number;
}
export interface OddsTotals {
  total_line: number;
  over_odds: number;
  under_odds: number;
  book_count: number;
}
export interface OddsSpreads {
  home_spread: number;
  home_spread_odds: number;
  book_count: number;
}
export interface OddsGame {
  home: string;
  away: string;
  game_number: number;
  h2h: OddsH2H | null;
  spreads: OddsSpreads | null;
  totals: OddsTotals | null;
  books: unknown[];
  game_time: string | null;
}
export interface OddsResponse {
  date: string;
  games: OddsGame[];
}

export interface PitcherLeaderRow {
  mlb_id: number;
  name: string;
  team: string | null;
  position: string | null;
  season: number;
  games: number;
  innings_pitched: number;
  era: number | null;
  k_percent: number | null;
  bb_percent: number | null;
  whiff_percent: number | null;
  oz_swing_percent: number | null;
  iz_contact_percent: number | null;
  barrel_batted_rate: number | null;
  hard_hit_percent: number | null;
  exit_velocity_avg: number | null;
  xwoba: number | null;
  woba: number | null;
  strikeouts: number;
  walks: number;
  fastball_velo: number | null;
  pitch_hand: string | null;
}

export interface HitterLeaderRow {
  mlb_id: number;
  name: string;
  team: string;
  position: string;
  window: number;
  ops: number;
  avg: number;
  obp: number;
  slg: number;
  iso: number;
  home_runs: number;
  at_bats: number;
  hits: number;
  strikeouts: number;
  walks: number;
  games: number;
  exit_velocity_avg: number | null;
}

export interface WeeklyRecord {
  wins: number;
  losses: number;
  units: number;
  pending: number;
}
export interface UnitsWeeklyResponse {
  week_start: string;
  week_end: string;
  all: WeeklyRecord | null;
  ev: WeeklyRecord | null;
}

export interface DataVersion {
  lineup: number;
  predictions: number;
}

export interface HistoricalSituation {
  inning: number;
  inning_half: string;
  balls: number;
  strikes: number;
  outs: number;
  on_first: boolean;
  on_second: boolean;
  on_third: boolean;
  batter: string;
  pitcher: string;
}
export interface HistoricalGame {
  home_team: string;
  away_team: string;
  game_number: number;
  home_score: number | null;
  away_score: number | null;
  home_won: number | null;
  game_state: "pre" | "in" | "post";
  game_detail: string | null;
  situation: HistoricalSituation | null;
  game_time: string | null;
}
export interface HistoricalResponse {
  date: string;
  games: HistoricalGame[];
}

export type LiveStrikeouts = Record<string, { ks: number; gameState: "Live" | "Final" }>;
export type LiveHomeruns = Record<string, { hrs: number; gameState: "Live" | "Final" | "Preview" }>;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
}
export interface AuthResponse {
  token: string;
  user: AuthUser;
}
