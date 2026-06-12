"""
predictorV4.py - MLB Prediction Engine (Optimized)
===================================================
Proven feature set from statistical analysis:
- L30/L15/L5 rolling run differential per team (most important)
- Career-weighted SP ERA, xwOBA, K%, BB%, whiff%, hard-hit%, barrel%
- Park run factor and weather (temperature + wind)
- Home field advantage

Measured on holdout: AUC=0.561, run MAE=3.5, pred range 5.2-19.0
"""

import sys
import unicodedata
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import argparse, json, pickle, sqlite3, warnings
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import accuracy_score, mean_absolute_error, roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

DB_PATH      = Path(__file__).parent / "mlb.db"
MODEL_PATH   = Path(__file__).parent / "mlb_model_v4.pkl"
ELO_PATH     = Path(__file__).parent / "elo_ratings_v4.json"
FEATURES_PATH = Path(__file__).parent / "mlb_features_v4.json"

# -------------------------------------------------------------------------
# DB helpers
# -------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = lambda c, r: {col[0]: r[i] for i,col in enumerate(c.description)}
    return conn

def _strip_accents(s):
    """Normalize unicode accents so 'Sánchez' == 'Sanchez' in comparisons."""
    return ''.join(c for c in unicodedata.normalize('NFD', s)
                   if unicodedata.category(c) != 'Mn')

def q(conn, sql, p=()):  return conn.execute(sql, p).fetchall()
def q1(conn, sql, p=()): return conn.execute(sql, p).fetchone()

def safe(v, d=0.0):
    if v is None: return d
    try:
        f = float(v)
        return d if (np.isnan(f) or np.isinf(f)) else f
    except: return d

# -------------------------------------------------------------------------
# Load static reference data
# -------------------------------------------------------------------------

def load_sp_career_stats(conn):
    """Career-weighted SP stats from all available Savant seasons."""
    rows = q(conn, """
        SELECT name,
               AVG(era)                 as era,
               AVG(xwoba)               as xwoba,
               AVG(k_percent)           as kpct,
               AVG(bb_percent)          as bbpct,
               AVG(whiff_percent)       as whiff,
               AVG(hard_hit_percent)    as hh,
               AVG(barrel_batted_rate)  as barrel,
               AVG(exit_velocity_avg)   as ev,
               COUNT(*)                 as seasons
        FROM savant_pitcher_stats
        WHERE era > 0 AND era < 10 AND pa > 50
        GROUP BY name
    """)
    return {r["name"]: r for r in rows}


def load_park_factors(conn):
    """Average run factor per park (normalized: 100 = neutral)."""
    rows = q(conn, """
        SELECT park_id, AVG(run_factor) as rf
        FROM park_factors WHERE run_factor IS NOT NULL AND season >= 2010
        GROUP BY park_id
    """)
    return {r["park_id"]: safe(r["rf"], 100.0) / 100.0 for r in rows}


# HR park factors (empirical; HRs drive ~30% of run production, so blended weight=0.30)
_HR_PARK_FACTORS = {
    "NYC21": 1.21, "LOS03": 1.18, "HOU03": 1.14, "CIN09": 1.14, "MIL06": 1.11,
    "BAL12": 1.11, "ANA01": 1.08, "NYC20": 1.08, "CLE08": 1.07, "MIN04": 1.07,
    "DEN02": 1.20, "SAC01": 1.04, "PHI13": 1.04, "SAN02": 1.05, "KAN06": 1.02,
    "STL10": 1.02, "DET05": 1.00, "ARL03": 1.00, "PIT08": 1.00, "STP01": 0.99,
    "TAM02": 0.99, "TOR02": 0.99, "PHO01": 0.95, "MIA02": 0.95, "BOS07": 0.95,
    "ATL03": 0.97, "CHI12": 0.93, "SEA03": 0.92, "WAS11": 0.87, "CHI11": 0.86,
    "SFO03": 0.73,
}

def get_hr_park_factor(park_id):
    """Return HR park factor; blended contribution to run total = (factor-1)*0.30."""
    return _HR_PARK_FACTORS.get(park_id, 1.0)


def load_weather(conn):
    """Weather keyed by (park_id, YYYYMMDD)."""
    rows = q(conn, """
        SELECT park_id, game_date, temperature_f, wind_speed_mph, wind_direction
        FROM game_weather WHERE game_date >= '20100101'
    """)
    return {(r["park_id"], r["game_date"]): r for r in rows}


def load_lineup_stats(conn):
    """Aggregate lineup OPS/OBP/SLG/ISO per (game_date, team) from historical_lineups.
    Only batting positions 1-9; provides offensive quality per game."""
    rows = q(conn, """
        SELECT game_date, team,
               AVG(ops)  as lineup_ops,
               AVG(obp)  as lineup_obp,
               AVG(slg)  as lineup_slg,
               AVG(iso)  as lineup_iso,
               COUNT(*)  as lineup_n
        FROM historical_lineups
        WHERE batting_order BETWEEN 1 AND 9
          AND ops IS NOT NULL
        GROUP BY game_date, team
    """)
    return {(r["game_date"], r["team"]): r for r in rows}


def load_lineup_players(conn):
    """Map (game_date, team) -> ordered list of player names (batting positions 1-9)."""
    rows = q(conn, """
        SELECT game_date, team, name
        FROM historical_lineups
        WHERE batting_order BETWEEN 1 AND 9
        ORDER BY game_date, team, batting_order
    """)
    result = defaultdict(list)
    for r in rows:
        result[(r["game_date"], r["team"])].append(r["name"])
    return dict(result)


def load_pitcher_recent_form(conn):
    """Recent L15 and L5 ERA/WHIP/K9 for SPs.
    L15 = medium-term form (stable); L5 = hot/cold streak signal."""
    rows15 = q(conn, """
        SELECT name, season, era, whip,
               CASE WHEN innings_pitched > 0
                    THEN strikeouts * 9.0 / innings_pitched ELSE NULL END as k9,
               games_started
        FROM pitcher_recent_stats
        WHERE window = 10 AND games_started >= 1
    """)
    rows5 = q(conn, """
        SELECT name, season, era, whip,
               CASE WHEN innings_pitched > 0
                    THEN strikeouts * 9.0 / innings_pitched ELSE NULL END as k9,
               games_started
        FROM pitcher_recent_stats
        WHERE window = 5 AND games_started >= 1
    """)
    return (
        {(r["name"], r["season"]): r for r in rows15},
        {(r["name"], r["season"]): r for r in rows5},
    )


def load_h2h_ops_map(conn):
    """Career H2H OPS per (hitter_name, pitcher_name) with min 5 AB.
    Used to estimate lineup matchup advantage vs opposing SP."""
    rows = q(conn, """
        SELECT hitter_name, pitcher_name,
               SUM(at_bats) as ab,
               AVG(ops)     as h2h_ops
        FROM hitter_vs_pitcher
        GROUP BY hitter_name, pitcher_name
        HAVING SUM(at_bats) >= 5
    """)
    return {(r["hitter_name"], r["pitcher_name"]): r for r in rows}


def load_savant_hitter_season(conn):
    """Statcast hitter metrics keyed by (name, season). Expanded to include plate discipline."""
    rows = q(conn, """
        SELECT name, season,
               barrel_batted_rate  as barrel,
               exit_velocity_avg   as ev,
               hard_hit_percent    as hh,
               xwoba,
               k_percent           as k_pct,
               bb_percent          as bb_pct,
               whiff_percent       as whiff,
               oz_swing_percent    as chase_pct,
               iz_contact_percent  as iz_contact,
               bat_speed           as bat_speed,
               xslg                as xslg,
               xba                 as xba
        FROM savant_hitter_stats
        WHERE pa >= 100
    """)
    return {(r["name"], r["season"]): r for r in rows}


def load_sp_season_stats(conn):
    """Most recent season Statcast stats per SP: fastball speed, quality metrics.
    Keyed by (name, season). Used to get current-season form beyond career averages."""
    rows = q(conn, """
        SELECT name, season,
               era, xwoba, k_percent as kpct, bb_percent as bbpct,
               whiff_percent as whiff, hard_hit_percent as hh,
               barrel_batted_rate as barrel,
               exit_velocity_avg  as ev,
               ff_avg_speed       as ff_speed,
               fastball_avg_spin  as ff_spin,
               breaking_avg_speed as brk_speed,
               innings_pitched    as ip,
               pa
        FROM savant_pitcher_stats
        WHERE pa >= 50 AND era > 0 AND era < 12
    """)
    return {(r["name"], r["season"]): r for r in rows}


def load_hitter_rolling_ops(conn, window=14):
    """Compute rolling OPS/HR-rate for each (player, game_date) from cumulative historical_lineups.
    Since historical_lineups stores cumulative season stats per date, we subtract
    stats from `window` games ago to isolate the recent window.
    Returns {(name, game_date): {recent_ops, recent_hr_rate, window_ab}} for games with >= 5 AB."""
    rows = q(conn, """
        SELECT name, game_date, games, at_bats, hits, doubles, triples,
               home_runs, walks
        FROM historical_lineups
        WHERE batting_order BETWEEN 1 AND 9
          AND at_bats IS NOT NULL AND at_bats > 0
        ORDER BY name, game_date
    """)

    by_player = defaultdict(list)
    for r in rows:
        by_player[r["name"]].append(r)

    result = {}
    for name, entries in by_player.items():
        for i, curr in enumerate(entries):
            target_g = curr["games"] - window
            if target_g < 0:
                continue
            # Find the most recent prior entry with games <= target_g
            prior = None
            for j in range(i - 1, -1, -1):
                if entries[j]["games"] <= target_g:
                    prior = entries[j]
                    break
            if prior is None:
                continue
            dAB = curr["at_bats"]   - prior["at_bats"]
            dH  = curr["hits"]      - prior["hits"]
            d2B = curr["doubles"]   - prior["doubles"]
            d3B = curr["triples"]   - prior["triples"]
            dHR = curr["home_runs"] - prior["home_runs"]
            dBB = curr["walks"]     - prior["walks"]
            if dAB < 5:
                continue
            dPA  = dAB + dBB
            obp  = (dH + dBB) / dPA if dPA > 0 else 0.300
            slg  = (dH + d2B + 2 * d3B + 3 * dHR) / dAB
            result[(name, curr["game_date"])] = {
                "recent_ops":     obp + slg,
                "recent_hr_rate": dHR / dAB,
                "window_ab":      dAB,
            }

    return result


# ── Park CF orientations (home plate → center field, compass degrees) ──────────
# Wind FROM (cf_bearing + 180°) = blowing OUT toward CF = more runs
# Source: stadium geometry surveys
_PARK_CF_BEARING = {
    "DEN02": 250, "NYC21":  52, "BOS07":  95, "CHI11":  45, "SFO03":  28,
    "LOS03":  42, "ATL03": 320, "ANA01":  20, "ARL03":  30, "BAL12":  75,
    "CHI12":  10, "CIN09":  35, "CLE08":  15, "DET05": 220, "KAN06":  50,
    "NYC20":  15, "SAC01":  30, "OAK01":  30, "PHI13":  50, "PIT08": 250,
    "SAN02":  10, "STL10":  50, "WAS11":  15, "TOR02":  50, "MIN04":  18,
    "SEA03": 350, "MIL06":  30, "HOU03":  20, "MIA02":  50, "TAM02":  20,
    "PHO01":  25,
}

# Park elevations above sea level (feet).
# Thin air at altitude → ball carries further; amplifies temperature carry effect.
# Air density at elevation e (ft) ≈ sea-level × (1 - e/145442)^5.256
_PARK_ELEVATIONS = {
    "DEN02": 5280,  # Coors Field — 80% sea-level air density, dominant effect
    "PHO01": 1082,  # Chase Field
    "ATL03": 1050,  # Truist Park
    "ARL03":  551,  # Globe Life Field
    "KAN06":  750,  # Kauffman Stadium
    "STL10":  466,  # Busch Stadium
    "MIN04":  830,  # Target Field
    "SAC01":   30,  # Sutter Health Park
}


def get_weather_features(wx_map, park_id, game_date):
    """Return temperature and wind run-adjustment features.

    Changes vs v3:
    - Field-level wind correction (×0.55) — weather station readings are ~2× field speed
    - Park-specific CF bearing + cosine alignment (replaces generic SE/S/SW heuristic)
    - Elevation temperature multiplier — thin air amplifies carry effect per °F
    - Consistent methodology with hrPredictor.py
    """
    import math

    date_nd = game_date.replace("-", "") if game_date else ""

    # 1. Exact date match
    wx = wx_map.get((park_id, date_nd), {})

    # 2. Average same calendar month/day across 5 most recent available years
    if not wx and date_nd and len(date_nd) == 8:
        suffix = date_nd[4:]
        candidates = [v for k, v in wx_map.items()
                      if k[0] == park_id and k[1].endswith(suffix)]
        if candidates:
            candidates.sort(key=lambda x: x.get("game_date", "0"), reverse=True)
            recent = candidates[:5]
            temps  = [safe(r.get("temperature_f"),  72.0) for r in recent]
            speeds = [safe(r.get("wind_speed_mph"),   0.0) for r in recent]
            dirs   = [safe(r.get("wind_direction"),  180.0) for r in recent]
            wx = {
                "temperature_f":  sum(temps)  / len(temps),
                "wind_speed_mph": sum(speeds) / len(speeds),
                "wind_direction": sum(dirs)   / len(dirs),
            }

    temp     = safe(wx.get("temperature_f"),  72.0)
    wind_raw = safe(wx.get("wind_speed_mph"),   0.0)
    wind_dir = safe(wx.get("wind_direction"),  180.0)

    # Elevation — thin air amplifies the temperature carry effect.
    # At Coors (5280 ft, ~80% density) a 10°F increase carries the ball ~25% further
    # than at sea level for the same ΔT, so the temperature coefficient is scaled up.
    elev_ft      = _PARK_ELEVATIONS.get(park_id, 0)
    elev_temp_mult = 1.0 + (elev_ft / 5280.0) * 0.40  # up to +40% at Coors elevation

    # Temperature run adjustment (baseline 70°F)
    temp_adj = (temp - 70.0) / 10.0 * 0.5 * elev_temp_mult

    # Field-level wind speed: weather-station readings are ~1.5–2× actual field speed
    # due to instrument height and stadium windbreak effect. Apply 0.55 correction.
    wind_spd = wind_raw * 0.55

    # Park-specific CF bearing → cosine alignment → signed run effect
    wind_out = 0.0
    if wind_spd >= 2:
        cf_bearing   = _PARK_CF_BEARING.get(park_id, 45)
        wind_toward  = (wind_dir + 180) % 360          # direction wind goes (not from)
        angle_diff   = abs(wind_toward - cf_bearing)
        if angle_diff > 180:
            angle_diff = 360 - angle_diff
        alignment = math.cos(math.radians(angle_diff))  # +1 = pure tailwind, -1 = headwind

        if alignment > 0:   # tailwind toward CF — boosts scoring
            wind_out = alignment * (wind_spd / 10.0) * 0.80
        else:               # headwind or crosswind — suppresses scoring
            wind_out = alignment * (wind_spd / 10.0) * 0.55

    return {
        "temp_f":    temp,
        "temp_adj":  temp_adj,
        "wind_out":  wind_out,
        "elev_ft":   float(elev_ft),
    }

# -------------------------------------------------------------------------
# Rolling team stats
# -------------------------------------------------------------------------

class TeamWindow:
    def __init__(self):
        self._rs = []; self._ra = []; self._w = []

    def add(self, rs, ra, won):
        self._rs.append(float(rs)); self._ra.append(float(ra)); self._w.append(float(won))

    def stats(self, n):
        rs = self._rs[-n:]; ra = self._ra[-n:]; w = self._w[-n:]
        if len(rs) < 3: return None
        return {
            "rpg":      np.mean(rs),
            "rapg":     np.mean(ra),
            "rdiff":    np.mean(rs) - np.mean(ra),
            "win_pct":  np.mean(w),
        }

    def streak_stats(self):
        """Return current win/loss streak length and momentum features."""
        w = self._w
        if len(w) < 3:
            return {"win_streak": 0, "loss_streak": 0, "streak_len": 0}
        # Count consecutive same outcome from end
        last = w[-1]
        streak = 1
        for i in range(len(w) - 2, -1, -1):
            if w[i] == last:
                streak += 1
            else:
                break
        win_streak  = streak if last == 1.0 else 0
        loss_streak = streak if last == 0.0 else 0
        return {
            "win_streak":  win_streak,
            "loss_streak": loss_streak,
            "streak_len":  streak if last == 1.0 else -streak,  # signed: pos=wins, neg=losses
        }

    def ewm_rdiff(self, span=7):
        """Exponentially weighted recent run differential (emphasises last ~span games)."""
        if len(self._rs) < 3:
            return 0.0
        diffs = [rs - ra for rs, ra in zip(self._rs, self._ra)]
        alpha = 2.0 / (span + 1)
        ewm = diffs[0]
        for d in diffs[1:]:
            ewm = alpha * d + (1 - alpha) * ewm
        return ewm

# -------------------------------------------------------------------------
# Elo
# -------------------------------------------------------------------------

def compute_elo(conn):
    print("   Computing Elo ratings...")
    games = q(conn, """
        SELECT game_date, season, home_team, away_team, home_won
        FROM game_results WHERE home_won IS NOT NULL ORDER BY game_date
    """)
    ratings = {}; history = {}
    K = 20; HOME_ADV = 30; prev_season = None

    for g in games:
        home, away, season = g["home_team"], g["away_team"], g["season"]
        if home not in ratings: ratings[home] = 1500
        if away not in ratings: ratings[away] = 1500

        if season != prev_season and prev_season:
            for t in ratings: ratings[t] = ratings[t] * 0.67 + 500
        prev_season = season

        history[(home, g["game_date"])] = ratings[home]
        history[(away, g["game_date"])] = ratings[away]

        exp_h = 1 / (1 + 10 ** ((ratings[away] - ratings[home] - HOME_ADV) / 400))
        delta = K * (g["home_won"] - exp_h)
        ratings[home] += delta; ratings[away] -= delta

    with open(ELO_PATH, "w") as f:
        json.dump({str(t): v for t,v in ratings.items()}, f, indent=2)
    print(f"   Elo done: {len(ratings)} teams")
    return history, ratings

# -------------------------------------------------------------------------
# Feature builder (shared between training and prediction)
# -------------------------------------------------------------------------

def sp_feats(sp, prefix, sp_szn=None):
    """Extract SP career stat features; optionally blend with current-season Statcast."""
    era    = safe(sp.get("era"),    4.20) if sp else 4.20
    xwoba  = safe(sp.get("xwoba"), 0.320) if sp else 0.320
    kpct   = safe(sp.get("kpct"),  22.0) if sp else 22.0
    bbpct  = safe(sp.get("bbpct"),  8.0) if sp else  8.0
    whiff  = safe(sp.get("whiff"), 24.0) if sp else 24.0
    hh     = safe(sp.get("hh"),    36.0) if sp else 36.0
    barrel = safe(sp.get("barrel"), 8.0) if sp else  8.0
    ev     = safe(sp.get("ev"),    88.5) if sp else 88.5
    rps    = max(0.5, min(9.0, era * 5.5 / 9.0))
    # Current-season overrides (more responsive than career avg)
    if sp_szn:
        if sp_szn.get("era")    is not None: era    = safe(sp_szn["era"],    era)
        if sp_szn.get("xwoba")  is not None: xwoba  = safe(sp_szn["xwoba"],  xwoba)
        if sp_szn.get("kpct")   is not None: kpct   = safe(sp_szn["kpct"],   kpct)
        if sp_szn.get("bbpct")  is not None: bbpct  = safe(sp_szn["bbpct"],  bbpct)
        if sp_szn.get("whiff")  is not None: whiff  = safe(sp_szn["whiff"],  whiff)
        if sp_szn.get("hh")     is not None: hh     = safe(sp_szn["hh"],     hh)
        if sp_szn.get("barrel") is not None: barrel = safe(sp_szn["barrel"], barrel)
        if sp_szn.get("ev")     is not None: ev     = safe(sp_szn["ev"],     ev)
        rps = max(0.5, min(9.0, era * 5.5 / 9.0))
    ff_speed = safe(sp_szn.get("ff_speed"), 93.0) if sp_szn else 93.0
    return {
        f"{prefix}_era":     era,
        f"{prefix}_xwoba":   xwoba,
        f"{prefix}_kpct":    kpct,
        f"{prefix}_bbpct":   bbpct,
        f"{prefix}_whiff":   whiff,
        f"{prefix}_hh":      hh,
        f"{prefix}_barrel":  barrel,
        f"{prefix}_ev":      ev,       # exit velocity allowed
        f"{prefix}_ff_speed":ff_speed, # fastball velocity
        f"{prefix}_rps":     rps,
    }

def _team_h2h_ops(batters, sp_name, h2h_map):
    """Average career H2H OPS of a batter list vs a specific pitcher (min 5 AB pairs)."""
    if not sp_name or not batters:
        return None
    vals = [safe(h2h_map[(b, sp_name)]["h2h_ops"], 0.720)
            for b in batters if (b, sp_name) in h2h_map]
    return sum(vals) / len(vals) if vals else None


def _team_savant_avg(batters, season, savant_map, col, default):
    """Average a Statcast metric across a lineup; tries current then prior season."""
    vals = []
    for b in batters:
        entry = savant_map.get((b, season)) or savant_map.get((b, season - 1))
        if entry and entry.get(col) is not None:
            vals.append(safe(entry[col], default))
    return sum(vals) / len(vals) if vals else default


def _lineup_recent_form(batters, game_date, rolling_ops):
    """Compute average rolling OPS/HR-rate for batters with recent data.
    Returns (avg_recent_ops, avg_hr_rate, coverage) where coverage=fraction of lineup with data."""
    ops_vals, hr_vals = [], []
    for b in batters:
        e = rolling_ops.get((b, game_date))
        if e and e["window_ab"] >= 5:
            ops_vals.append(e["recent_ops"])
            hr_vals.append(e["recent_hr_rate"])
    n = len(batters) or 1
    return (
        sum(ops_vals) / len(ops_vals) if ops_vals else None,
        sum(hr_vals)  / len(hr_vals)  if hr_vals  else None,
        len(ops_vals) / n,
    )


def build_game_features(home, away, h_win, h_rs, h5, h15, h30, a5, a15, a30,
                         home_sp, away_sp, park_rf, wx_feats, elo_home, elo_away,
                         season,
                         game_date=None, lineup_stats=None, lineup_players=None,
                         pitcher_recent=None, pitcher_recent_l5=None,
                         h2h_map=None, savant_hitters=None,
                         home_sp_name=None, away_sp_name=None,
                         home_streak=None, away_streak=None,
                         home_ewm_rdiff=0.0, away_ewm_rdiff=0.0,
                         sp_season_stats=None, hitter_rolling=None):
    """Build the full feature vector for one game."""
    h5r  = h5  or h15
    a5r  = a5  or a15
    h30r = h30 or h15
    a30r = a30 or a15

    f = {}

    # -- Rolling team performance (most predictive) ----------------------
    # L30: season-level quality (stable)
    f["home_rdiff_30"]   = h30r["rdiff"]
    f["away_rdiff_30"]   = a30r["rdiff"]
    f["rdiff_30_adv"]    = h30r["rdiff"] - a30r["rdiff"]
    f["home_rpg_30"]     = h30r["rpg"]
    f["away_rpg_30"]     = a30r["rpg"]
    f["home_rapg_30"]    = h30r["rapg"]
    f["away_rapg_30"]    = a30r["rapg"]
    f["home_wpct_30"]    = h30r["win_pct"]
    f["away_wpct_30"]    = a30r["win_pct"]
    f["wpct_adv_30"]     = h30r["win_pct"] - a30r["win_pct"]
    f["combined_rpg_30"] = h30r["rpg"] + a30r["rpg"]   # run total signal

    # L15: medium-term form
    f["home_rdiff_15"]   = h15["rdiff"]
    f["away_rdiff_15"]   = a15["rdiff"]
    f["rdiff_15_adv"]    = h15["rdiff"] - a15["rdiff"]
    f["home_rpg_15"]     = h15["rpg"]
    f["away_rpg_15"]     = a15["rpg"]
    f["home_rapg_15"]    = h15["rapg"]
    f["away_rapg_15"]    = a15["rapg"]
    f["home_wpct_15"]    = h15["win_pct"]
    f["away_wpct_15"]    = a15["win_pct"]
    f["combined_rpg_15"] = h15["rpg"] + a15["rpg"]

    # L5: hot/cold streaks
    f["home_rdiff_5"]    = h5r["rdiff"]
    f["away_rdiff_5"]    = a5r["rdiff"]
    f["rdiff_5_adv"]     = h5r["rdiff"] - a5r["rdiff"]
    f["home_wpct_5"]     = h5r["win_pct"]
    f["away_wpct_5"]     = a5r["win_pct"]

    # -- Streak & momentum features ---------------------------------------
    _hs = home_streak or {}
    _as = away_streak or {}
    h_win_str  = float(_hs.get("win_streak",  0))
    h_loss_str = float(_hs.get("loss_streak", 0))
    h_str_len  = float(_hs.get("streak_len",  0))
    a_win_str  = float(_as.get("win_streak",  0))
    a_loss_str = float(_as.get("loss_streak", 0))
    a_str_len  = float(_as.get("streak_len",  0))

    f["home_win_streak"]   = h_win_str
    f["away_win_streak"]   = a_win_str
    f["home_loss_streak"]  = h_loss_str
    f["away_loss_streak"]  = a_loss_str
    f["streak_len_home"]   = h_str_len   # signed: +N=win run, -N=loss run
    f["streak_len_away"]   = a_str_len
    f["streak_adv"]        = h_str_len - a_str_len  # net momentum edge for home

    # Trend: L5 vs L15 (acceleration — positive = team is improving)
    f["home_wpct_trend"]   = h5r["win_pct"] - h15["win_pct"]
    f["away_wpct_trend"]   = a5r["win_pct"] - a15["win_pct"]
    f["home_rdiff_trend"]  = h5r["rdiff"]   - h15["rdiff"]
    f["away_rdiff_trend"]  = a5r["rdiff"]   - a15["rdiff"]
    f["wpct_trend_adv"]    = f["home_wpct_trend"] - f["away_wpct_trend"]
    f["rdiff_trend_adv"]   = f["home_rdiff_trend"] - f["away_rdiff_trend"]

    # Exponentially weighted run differential (heavier weight on recent games)
    f["home_ewm_rdiff"]    = home_ewm_rdiff
    f["away_ewm_rdiff"]    = away_ewm_rdiff
    f["ewm_rdiff_adv"]     = home_ewm_rdiff - away_ewm_rdiff

    # -- SP quality -------------------------------------------------------
    # Use current-season Statcast if available; fall back to career avg
    _szn = sp_season_stats or {}
    h_sp_szn = _szn.get((home_sp_name, season)) if home_sp_name else None
    a_sp_szn = _szn.get((away_sp_name, season)) if away_sp_name else None
    f.update(sp_feats(home_sp, "home_sp", h_sp_szn))
    f.update(sp_feats(away_sp, "away_sp", a_sp_szn))

    # Differentials (home advantage in pitching matchup)
    f["sp_era_adv"]     = f["away_sp_era"]     - f["home_sp_era"]    # pos = home SP better
    f["sp_xwoba_adv"]   = f["away_sp_xwoba"]   - f["home_sp_xwoba"]
    f["sp_kpct_adv"]    = f["home_sp_kpct"]    - f["away_sp_kpct"]   # home K's more
    f["sp_bb_adv"]      = f["away_sp_bbpct"]   - f["home_sp_bbpct"]  # home walks fewer
    f["sp_whiff_adv"]   = f["home_sp_whiff"]   - f["away_sp_whiff"]
    f["sp_hh_adv"]      = f["away_sp_hh"]      - f["home_sp_hh"]     # home allows less hard contact
    f["sp_ev_adv"]      = f["away_sp_ev"]      - f["home_sp_ev"]     # home allows lower EV
    f["sp_ff_speed_adv"]= f["home_sp_ff_speed"]- f["away_sp_ff_speed"] # home throws harder

    # Run total components
    f["sp_total_rps"]  = f["home_sp_rps"] + f["away_sp_rps"]
    f["adj_sp_rps"]    = f["sp_total_rps"] * park_rf  # park-adjusted starter runs

    # -- Environment ------------------------------------------------------
    f["park_rf"]       = park_rf
    f["temp_f"]        = wx_feats["temp_f"]
    f["temp_adj"]      = wx_feats["temp_adj"]   # already elevation-scaled
    f["wind_out"]      = wx_feats["wind_out"]   # park-specific CF bearing, field-level speed
    f["elev_ft"]       = wx_feats["elev_ft"]    # direct elevation feature for model
    # env_run_adj: combined environmental run contribution above neutral.
    # temp_adj and wind_out are already elevation-aware; park_rf is the 3-yr avg run factor.
    f["env_run_adj"]   = wx_feats["temp_adj"] + wx_feats["wind_out"] + (park_rf - 1.0) * 9.0

    # -- Elo --------------------------------------------------------------
    f["elo_diff"]      = elo_home - elo_away
    f["home_elo"]      = elo_home
    f["away_elo"]      = elo_away

    # -- Home field -------------------------------------------------------
    f["home_field"]    = 1.0   # constant, but useful for model calibration
    f["season"]        = season

    # -- Lineup quality (from historical_lineups / daily_lineups) ----------
    _ls = lineup_stats or {}
    h_lu = _ls.get((game_date, home), {}) if game_date else {}
    a_lu = _ls.get((game_date, away), {}) if game_date else {}
    h_ops = safe(h_lu.get("lineup_ops"), 0.720)
    h_iso = safe(h_lu.get("lineup_iso"), 0.150)
    a_ops = safe(a_lu.get("lineup_ops"), 0.720)
    a_iso = safe(a_lu.get("lineup_iso"), 0.150)
    f["home_lineup_ops"]  = h_ops
    f["home_lineup_iso"]  = h_iso
    f["away_lineup_ops"]  = a_ops
    f["away_lineup_iso"]  = a_iso
    f["lineup_ops_adv"]   = h_ops - a_ops
    f["lineup_iso_adv"]   = h_iso - a_iso

    # -- SP recent L15 form -----------------------------------------------
    _pr = pitcher_recent or {}
    h_rec = _pr.get((home_sp_name, season)) if home_sp_name else None
    a_rec = _pr.get((away_sp_name, season)) if away_sp_name else None
    h_rec_era = safe(h_rec["era"] if h_rec else None, f["home_sp_era"])
    a_rec_era = safe(a_rec["era"] if a_rec else None, f["away_sp_era"])
    f["home_sp_recent_era"]  = h_rec_era
    f["away_sp_recent_era"]  = a_rec_era
    f["sp_recent_era_adv"]   = a_rec_era - h_rec_era   # pos = home SP in better recent form
    h_rec_k9 = safe(h_rec["k9"] if h_rec else None, f["home_sp_kpct"])
    a_rec_k9 = safe(a_rec["k9"] if a_rec else None, f["away_sp_kpct"])
    f["home_sp_recent_k9"]   = h_rec_k9
    f["away_sp_recent_k9"]   = a_rec_k9

    # -- SP recent L5 form (hot/cold streak — more responsive than L15) -------
    # L5 catches a pitcher entering/leaving a hot stretch before L15 reflects it.
    _pr5 = pitcher_recent_l5 or {}
    h_r5 = _pr5.get((home_sp_name, season)) if home_sp_name else None
    a_r5 = _pr5.get((away_sp_name, season)) if away_sp_name else None
    h_era5 = safe(h_r5["era"] if h_r5 else None, h_rec_era)   # fall back to L15
    a_era5 = safe(a_r5["era"] if a_r5 else None, a_rec_era)
    f["home_sp_era_l5"]      = h_era5
    f["away_sp_era_l5"]      = a_era5
    f["sp_era_l5_adv"]       = a_era5 - h_era5   # pos = home SP hotter right now
    h_k9_5 = safe(h_r5["k9"] if h_r5 else None, h_rec_k9)
    a_k9_5 = safe(a_r5["k9"] if a_r5 else None, a_rec_k9)
    f["home_sp_k9_l5"]       = h_k9_5
    f["away_sp_k9_l5"]       = a_k9_5
    # Era trend: positive = SP getting worse (L5 ERA higher than L15 ERA)
    f["home_sp_era_trend"]   = h_era5 - h_rec_era
    f["away_sp_era_trend"]   = a_era5 - a_rec_era

    # -- Combined SP quality (primary run-total differentiator) ---------------
    # Both SPs together determine how many runs will score in this specific game.
    # Combined ERA is a much stronger run-total signal than either SP alone.
    f["combined_sp_era"]        = h_rec_era + a_rec_era           # sum L15 ERAs
    f["combined_sp_era_l5"]     = h_era5 + a_era5                 # sum L5 ERAs (hot-streak sensitive)
    f["combined_sp_era_min"]    = min(h_rec_era, a_rec_era)       # ace-game signal
    f["combined_sp_k9"]         = (h_rec_k9 + a_rec_k9) / 2.0    # avg strikeout dominance L15
    f["combined_sp_k9_l5"]      = (h_k9_5 + a_k9_5) / 2.0        # avg K9 L5
    f["combined_sp_era_recent_vs_season"] = (
        (h_era5 + a_era5) - (f["home_sp_era"] + f["away_sp_era"])
    )  # pos = both SPs pitching worse recently than season avg

    # -- H2H lineup OPS vs opposing SP ------------------------------------
    _lp  = lineup_players or {}
    _h2h = h2h_map or {}
    h_batters = _lp.get((game_date, home), []) if game_date else []
    a_batters = _lp.get((game_date, away), []) if game_date else []
    h_h2h = _team_h2h_ops(h_batters, away_sp_name, _h2h)
    a_h2h = _team_h2h_ops(a_batters, home_sp_name, _h2h)
    f["home_h2h_ops"]   = h_h2h  if h_h2h  is not None else 0.720
    f["away_h2h_ops"]   = a_h2h  if a_h2h  is not None else 0.720
    f["h2h_ops_adv"]    = f["home_h2h_ops"] - f["away_h2h_ops"]
    f["home_h2h_known"] = 1.0 if h_h2h is not None else 0.0
    f["away_h2h_known"] = 1.0 if a_h2h is not None else 0.0

    # -- Statcast hitter quality: contact, power, plate discipline --------
    _sh = savant_hitters or {}
    def _savant(batters, col, default):
        return _team_savant_avg(batters, season, _sh, col, default) if batters else default

    f["home_lineup_xwoba"]   = _savant(h_batters, "xwoba",    0.310)
    f["home_lineup_barrel"]  = _savant(h_batters, "barrel",   7.0)
    f["home_lineup_hh"]      = _savant(h_batters, "hh",       36.0)
    f["home_lineup_kpct"]    = _savant(h_batters, "k_pct",    22.0)  # lineup K-rate
    f["home_lineup_bbpct"]   = _savant(h_batters, "bb_pct",   8.5)   # lineup walk-rate
    f["home_lineup_chase"]   = _savant(h_batters, "chase_pct",29.0)  # oz-swing (exploitability)
    f["home_lineup_whiff"]   = _savant(h_batters, "whiff",    24.0)
    f["home_lineup_xslg"]    = _savant(h_batters, "xslg",     0.410) # expected power
    f["home_lineup_bat_spd"] = _savant(h_batters, "bat_speed",71.0)  # raw bat speed

    f["away_lineup_xwoba"]   = _savant(a_batters, "xwoba",    0.310)
    f["away_lineup_barrel"]  = _savant(a_batters, "barrel",   7.0)
    f["away_lineup_hh"]      = _savant(a_batters, "hh",       36.0)
    f["away_lineup_kpct"]    = _savant(a_batters, "k_pct",    22.0)
    f["away_lineup_bbpct"]   = _savant(a_batters, "bb_pct",   8.5)
    f["away_lineup_chase"]   = _savant(a_batters, "chase_pct",29.0)
    f["away_lineup_whiff"]   = _savant(a_batters, "whiff",    24.0)
    f["away_lineup_xslg"]    = _savant(a_batters, "xslg",     0.410)
    f["away_lineup_bat_spd"] = _savant(a_batters, "bat_speed",71.0)

    f["lineup_xwoba_adv"]    = f["home_lineup_xwoba"]  - f["away_lineup_xwoba"]
    f["lineup_barrel_adv"]   = f["home_lineup_barrel"] - f["away_lineup_barrel"]
    f["lineup_kpct_adv"]     = f["away_lineup_kpct"]   - f["home_lineup_kpct"]   # home K's less = better
    f["lineup_bbpct_adv"]    = f["home_lineup_bbpct"]  - f["away_lineup_bbpct"]  # home walks more
    f["lineup_chase_adv"]    = f["away_lineup_chase"]  - f["home_lineup_chase"]  # home chases less
    f["lineup_xslg_adv"]     = f["home_lineup_xslg"]   - f["away_lineup_xslg"]

    # Matchup: lineup discipline vs opposing SP stuff
    # High-chase lineup facing high-whiff SP = big strikeout edge
    f["home_sp_whiff_vs_away_chase"] = f["home_sp_whiff"] * f["away_lineup_chase"] / 100.0
    f["away_sp_whiff_vs_home_chase"] = f["away_sp_whiff"] * f["home_lineup_chase"] / 100.0
    f["whiff_chase_adv"] = (f["home_sp_whiff"] * f["away_lineup_chase"] -
                            f["away_sp_whiff"] * f["home_lineup_chase"]) / 100.0

    # -- Recent individual hitter form (from rolling game log) ----------------
    # Only available for seasons with historical_lineups data (2024+).
    # For prior seasons: NaN → SimpleImputer fills with training mean.
    _hr = hitter_rolling or {}
    h_rec_ops, h_rec_hr, h_cov = _lineup_recent_form(h_batters, game_date, _hr)
    a_rec_ops, a_rec_hr, a_cov = _lineup_recent_form(a_batters, game_date, _hr)

    f["home_lineup_recent_ops"]    = h_rec_ops if h_rec_ops is not None else float("nan")
    f["away_lineup_recent_ops"]    = a_rec_ops if a_rec_ops is not None else float("nan")
    f["home_lineup_recent_hr_rate"]= h_rec_hr  if h_rec_hr  is not None else float("nan")
    f["away_lineup_recent_hr_rate"]= a_rec_hr  if a_rec_hr  is not None else float("nan")
    f["lineup_recent_ops_adv"]     = (h_rec_ops - a_rec_ops
                                      if h_rec_ops is not None and a_rec_ops is not None
                                      else float("nan"))
    # Delta vs season OPS: measures how hot/cold lineup is relative to baseline
    f["home_recent_ops_delta"]     = (h_rec_ops - f["home_lineup_ops"]
                                      if h_rec_ops is not None else float("nan"))
    f["away_recent_ops_delta"]     = (a_rec_ops - f["away_lineup_ops"]
                                      if a_rec_ops is not None else float("nan"))
    f["home_recent_coverage"]      = h_cov   # fraction of lineup with recent data
    f["away_recent_coverage"]      = a_cov

    return f

# -------------------------------------------------------------------------
# Build training data
# -------------------------------------------------------------------------

def build_training_data(elo_history):
    print("\n" + "="*62)
    print("  BUILDING TRAINING DATA")
    print("="*62)

    conn = get_db()

    sp_stats         = load_sp_career_stats(conn)
    sp_season_stats  = load_sp_season_stats(conn)
    park_facs        = load_park_factors(conn)
    wx_map           = load_weather(conn)
    lineup_stats     = load_lineup_stats(conn)
    lineup_players   = load_lineup_players(conn)
    pitcher_recent, pitcher_recent_l5 = load_pitcher_recent_form(conn)
    h2h_map          = load_h2h_ops_map(conn)
    savant_hitters   = load_savant_hitter_season(conn)
    hitter_rolling   = load_hitter_rolling_ops(conn)

    print(f"   SP stats:            {len(sp_stats):,} pitchers")
    print(f"   SP season stats:     {len(sp_season_stats):,} pitcher-seasons")
    print(f"   Park factors:        {len(park_facs):,} parks")
    print(f"   Weather records:     {len(wx_map):,}")
    print(f"   Lineup game-stats:   {len(lineup_stats):,} team-days")
    print(f"   Lineup player maps:  {len(lineup_players):,} team-days")
    print(f"   Pitcher L15 form:    {len(pitcher_recent):,} pitcher-seasons")
    print(f"   Pitcher L5 form:     {len(pitcher_recent_l5):,} pitcher-seasons")
    print(f"   H2H batter-pitcher:  {len(h2h_map):,} pairs")
    print(f"   Savant hitter stats: {len(savant_hitters):,} player-seasons")
    print(f"   Hitter rolling ops:  {len(hitter_rolling):,} player-game entries")

    games = q(conn, """
        SELECT game_date, season, home_team, away_team,
               home_score, away_score, home_won, total_runs,
               home_sp_name, away_sp_name, park_id
        FROM game_results
        WHERE season >= 2010 AND home_won IS NOT NULL AND home_score IS NOT NULL
        ORDER BY game_date
    """)
    conn.close()
    print(f"   Loaded {len(games):,} games from 2010+\n")

    windows = defaultdict(TeamWindow)
    rows    = []

    for g in games:
        home, away   = g["home_team"], g["away_team"]
        date, season = g["game_date"],  g["season"]

        if season < 2015:
            windows[home].add(g["home_score"], g["away_score"], g["home_won"])
            windows[away].add(g["away_score"], g["home_score"], 1 - g["home_won"])
            continue

        h5  = windows[home].stats(5)
        h15 = windows[home].stats(15)
        h30 = windows[home].stats(30)
        a5  = windows[away].stats(5)
        a15 = windows[away].stats(15)
        a30 = windows[away].stats(30)

        if not h15 or not a15:
            windows[home].add(g["home_score"], g["away_score"], g["home_won"])
            windows[away].add(g["away_score"], g["home_score"], 1 - g["home_won"])
            continue

        home_sp   = sp_stats.get(g["home_sp_name"])
        away_sp   = sp_stats.get(g["away_sp_name"])
        park_rf   = park_facs.get(g["park_id"], 1.0)
        wx_feats  = get_weather_features(wx_map, g["park_id"], date)
        elo_home  = elo_history.get((home, date), 1500)
        elo_away  = elo_history.get((away, date), 1500)

        h_streak = windows[home].streak_stats()
        a_streak = windows[away].streak_stats()
        h_ewm    = windows[home].ewm_rdiff()
        a_ewm    = windows[away].ewm_rdiff()

        feats = build_game_features(
            home, away, g["home_won"],
            g["home_score"],
            h5, h15, h30, a5, a15, a30,
            home_sp, away_sp,
            park_rf, wx_feats,
            elo_home, elo_away, season,
            game_date=date,
            lineup_stats=lineup_stats,
            lineup_players=lineup_players,
            pitcher_recent=pitcher_recent,
            pitcher_recent_l5=pitcher_recent_l5,
            h2h_map=h2h_map,
            savant_hitters=savant_hitters,
            home_sp_name=g["home_sp_name"],
            away_sp_name=g["away_sp_name"],
            home_streak=h_streak,
            away_streak=a_streak,
            home_ewm_rdiff=h_ewm,
            away_ewm_rdiff=a_ewm,
            sp_season_stats=sp_season_stats,
            hitter_rolling=hitter_rolling,
        )
        feats["home_won"]   = g["home_won"]
        feats["total_runs"] = g["total_runs"]

        rows.append(feats)
        windows[home].add(g["home_score"], g["away_score"], g["home_won"])
        windows[away].add(g["away_score"], g["home_score"], 1 - g["home_won"])

    df = pd.DataFrame(rows)
    print(f"   Built {df.shape[0]:,} training rows x {df.shape[1]} columns")

    runs = df["total_runs"].values
    print(f"   Run totals: mean={runs.mean():.2f} std={runs.std():.2f} "
          f"p10={np.percentile(runs,10):.0f} p90={np.percentile(runs,90):.0f}")

    sp_match = (df["home_sp_era"] != 4.2).sum()
    print(f"   SP stats matched: {sp_match:,} ({100*sp_match/len(df):.0f}%)")

    meta = ["home_won", "total_runs"]
    feature_cols = [c for c in df.columns if c not in meta]

    return df, feature_cols

# -------------------------------------------------------------------------
# Train
# -------------------------------------------------------------------------

def train_models(df, feature_cols):
    print("\n" + "="*62)
    print("  TRAINING MODELS")
    print("="*62)

    X      = df[feature_cols].values.astype(float)
    y      = df["home_won"].values.astype(float)
    y_runs = df["total_runs"].values.astype(float)

    # -- Winner model ----------------------------------------------------
    winner_pipe = Pipeline([
        ("imp",   SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("clf",   GradientBoostingClassifier(
            n_estimators=600,
            max_depth=4,
            learning_rate=0.025,
            subsample=0.7,
            min_samples_leaf=30,
            max_features=0.6,
            random_state=42
        ))
    ])

    tscv = TimeSeriesSplit(n_splits=5)
    aucs, accs = [], []
    print("\n   Winner model CV:")
    for fold, (tr, va) in enumerate(tscv.split(X), 1):
        winner_pipe.fit(X[tr], y[tr])
        probs = winner_pipe.predict_proba(X[va])[:, 1]
        auc = roc_auc_score(y[va], probs)
        acc = accuracy_score(y[va], probs >= 0.5)
        aucs.append(auc); accs.append(acc)
        print(f"   Fold {fold}: AUC={auc:.4f}  Acc={acc:.4f}  "
              f"prob_range=[{probs.min():.3f},{probs.max():.3f}]")
    print(f"   Mean AUC={np.mean(aucs):.4f}  Acc={np.mean(accs):.4f}")

    print("\n   Training final winner model...")
    winner_pipe.fit(X, y)

    imps = sorted(zip(feature_cols, winner_pipe.named_steps["clf"].feature_importances_),
                  key=lambda x: -x[1])
    print("\n   Top features:")
    for feat, imp in imps[:15]:
        print(f"     {feat:<28} {imp:.4f}")

    # -- Run total model -------------------------------------------------
    run_pipe = Pipeline([
        ("imp",   SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("reg",   GradientBoostingRegressor(
            n_estimators=500,
            max_depth=5,
            learning_rate=0.03,
            subsample=0.7,
            min_samples_leaf=20,
            max_features=0.7,
            loss="squared_error",
            random_state=42
        ))
    ])

    tscv_r = TimeSeriesSplit(n_splits=4)
    maes = []
    print("\n   Run total model CV:")
    for fold, (tr, va) in enumerate(tscv_r.split(X), 1):
        run_pipe.fit(X[tr], y_runs[tr])
        preds = run_pipe.predict(X[va])
        mae = mean_absolute_error(y_runs[va], preds)
        maes.append(mae)
        print(f"   Fold {fold}: MAE={mae:.3f}  range=[{preds.min():.1f},{preds.max():.1f}]")
    print(f"   Mean MAE={np.mean(maes):.3f}")

    print("\n   Training final run model...")
    run_pipe.fit(X, y_runs)

    run_imps = sorted(zip(feature_cols, run_pipe.named_steps["reg"].feature_importances_),
                      key=lambda x: -x[1])
    print("\n   Run model top features:")
    for feat, imp in run_imps[:10]:
        print(f"     {feat:<28} {imp:.4f}")

    metrics = {
        "winner_auc": float(np.mean(aucs)),
        "winner_acc": float(np.mean(accs)),
        "run_mae":    float(np.mean(maes)),
        "n_games":    len(df),
    }
    return winner_pipe, run_pipe, feature_cols, metrics

# -------------------------------------------------------------------------
# Predict today
# -------------------------------------------------------------------------

def predict_today(winner_model, run_model, feature_cols, current_elo, date_override=None):
    print("\n" + "="*62)
    print("  TODAY'S PREDICTIONS")
    print("="*62)

    conn    = get_db()
    sp_stats        = load_sp_career_stats(conn)
    sp_season_stats = load_sp_season_stats(conn)
    park_facs       = load_park_factors(conn)
    wx_map          = load_weather(conn)
    pitcher_recent, pitcher_recent_l5 = load_pitcher_recent_form(conn)
    h2h_map         = load_h2h_ops_map(conn)
    savant_hitters  = load_savant_hitter_season(conn)
    hitter_rolling  = load_hitter_rolling_ops(conn)
    today   = datetime.now().strftime("%Y-%m-%d")

    # When a past date is requested, read lineups from historical_lineups
    lineup_src = "historical_lineups" if (date_override and date_override < today) else "daily_lineups"
    pred_date  = date_override or today

    # Get lineups for the target date
    games = q(conn, f"""
        SELECT DISTINCT team, opponent, game_date, season
        FROM {lineup_src} WHERE game_date = ? AND batting_order > 0
    """, (pred_date,))

    if not games and lineup_src == "daily_lineups":
        latest = q1(conn, "SELECT MAX(game_date) as d FROM daily_lineups WHERE batting_order > 0")
        if latest and latest["d"]:
            games = q(conn, """
                SELECT DISTINCT team, opponent, game_date, season
                FROM daily_lineups WHERE game_date = ? AND batting_order > 0
            """, (latest["d"],))
            print(f"   (Using {latest['d']} - no lineups for today)\n")

    if not games:
        print(f"   No lineups found for {pred_date}. Run: node importDailyLineups.js")
        conn.close()
        return []

    date   = games[0]["game_date"]
    season = games[0]["season"]
    print(f"   Date: {date}\n")

    # Build lineup_stats and lineup_players from the target date's lineups
    dl_rows = q(conn, f"""
        SELECT team, name, batting_order, ops, iso
        FROM {lineup_src}
        WHERE game_date = ? AND batting_order BETWEEN 1 AND 9
        ORDER BY team, batting_order
    """, (date,))
    todays_lineup_stats   = {}
    todays_lineup_players = defaultdict(list)
    _lu_acc = defaultdict(list)
    for r in dl_rows:
        key = (date, r["team"])
        todays_lineup_players[key].append(r["name"])
        if r["ops"] is not None:
            _lu_acc[key].append({"ops": r["ops"], "iso": r.get("iso")})
    for key, entries in _lu_acc.items():
        ops_vals = [safe(e["ops"], 0.720) for e in entries]
        iso_vals = [safe(e["iso"], 0.150) for e in entries if e["iso"] is not None]
        todays_lineup_stats[key] = {
            "lineup_ops": sum(ops_vals) / len(ops_vals) if ops_vals else 0.720,
            "lineup_iso": sum(iso_vals) / len(iso_vals) if iso_vals else 0.150,
        }
    todays_lineup_players = dict(todays_lineup_players)

    # Build rolling windows from recent game_results
    windows = defaultdict(TeamWindow)
    all_games = q(conn, """
        SELECT game_date, season, home_team, away_team, home_score, away_score, home_won
        FROM game_results
        WHERE game_date < ? AND season >= ? AND home_score IS NOT NULL
        ORDER BY game_date
    """, (date, season - 1))

    for g in all_games:
        windows[g["home_team"]].add(g["home_score"], g["away_score"], g["home_won"])
        windows[g["away_team"]].add(g["away_score"], g["home_score"], 1 - g["home_won"])

    # Step 1: resolve home/away for each entry, deduplicate to one entry per game.
    # games has TWO rows per game (one per team), so we must resolve home/away first
    # before counting — otherwise the second team's entry looks like game 2.
    seen_ha = set()
    base_matchups = []
    for m in games:
        team1, team2 = m["team"], m["opponent"]

        home = away = None
        try:
            r1 = q1(conn, f"""
                SELECT team FROM {lineup_src}
                WHERE game_date=? AND team=? AND is_home=1 AND batting_order>0 LIMIT 1
            """, (date, team1))
            if r1:
                home, away = team1, team2
            else:
                r2 = q1(conn, f"""
                    SELECT team FROM {lineup_src}
                    WHERE game_date=? AND team=? AND is_home=1 AND batting_order>0 LIMIT 1
                """, (date, team2))
                if r2:
                    home, away = team2, team1
        except Exception:
            pass

        if not home:
            try:
                gr = q1(conn, """
                    SELECT home_team, away_team FROM game_results
                    WHERE ((home_team=? AND away_team=?) OR (home_team=? AND away_team=?))
                    ORDER BY game_date DESC LIMIT 1
                """, (team1, team2, team2, team1))
                if gr:
                    home, away = gr["home_team"], gr["away_team"]
            except Exception:
                pass

        if not home:
            home, away = team1, team2

        if (home, away) not in seen_ha:
            seen_ha.add((home, away))
            base_matchups.append({"home": home, "away": away, "date": date, "season": season})

    # Step 2: build matchups from game_schedule (authoritative ESPN schedule, populated
    # by server before running this script). Falls back to betting_odds if schedule
    # table is empty (e.g. first run before server has fetched schedule).
    from datetime import datetime as _dt, timedelta as _td
    def _sched_q(d):
        return q(conn, """
            SELECT game_number, home_sp_name, away_sp_name
            FROM game_schedule
            WHERE game_date=? AND (
                (home_team=? AND away_team=?) OR (home_team=? AND away_team=?)
            )
            ORDER BY game_number
        """, (d, bm["home"], bm["away"], bm["away"], bm["home"]))

    matchups = []
    for bm in base_matchups:
        sched = _sched_q(date)

        # If nothing found for the exact date, try the previous calendar day.
        # This handles the timezone edge case where daily_lineups is stored under
        # UTC date (e.g. 2026-05-01) but game_schedule uses ET date (2026-04-30).
        if not sched:
            prev = (_dt.strptime(date, "%Y-%m-%d") - _td(days=1)).strftime("%Y-%m-%d")
            sched = _sched_q(prev)

        if sched:
            for sr in sched:
                matchups.append({
                    **bm,
                    "game_number":   sr["game_number"],
                    "home_sp_ovr":   sr["home_sp_name"],
                    "away_sp_ovr":   sr["away_sp_name"],
                })
        else:
            # Fallback: betting_odds tells us how many games are scheduled
            odds_rows = q(conn, """
                SELECT DISTINCT game_number FROM betting_odds
                WHERE game_date=? AND (
                    (home_team=? AND away_team=?) OR (home_team=? AND away_team=?)
                )
                ORDER BY game_number
            """, (date, bm["home"], bm["away"], bm["away"], bm["home"]))
            for gn in ([r["game_number"] for r in odds_rows] or [1]):
                matchups.append({**bm, "game_number": gn, "home_sp_ovr": None, "away_sp_ovr": None})

    def _sp_from_recent(name, season):
        """Synthetic SP stats built from pitcher_recent_stats when Savant history is absent.
        Gives the GBR real ERA signal instead of the 4.20 league-average default."""
        if not name:
            return None
        rec15 = pitcher_recent.get((name, season))
        rec5  = pitcher_recent_l5.get((name, season))
        era = safe((rec15 or {}).get("era"), None) if rec15 else None
        if era is None:
            era = safe((rec5 or {}).get("era"), None) if rec5 else None
        if era is None:
            return None
        k9 = safe((rec15 or {}).get("k9"), safe((rec5 or {}).get("k9"), None) if rec5 else None)
        # Approximate K% from K/9: K9 ≈ (K / (K + (BFP - K))) * ~27 * K%
        kpct = min(35.0, max(12.0, k9 / 9.0 * 27.0 / 3.5)) if k9 else 22.0
        return {"era": era, "xwoba": 0.320, "kpct": kpct, "bbpct": 8.0,
                "whiff": 24.0, "hh": 36.0, "barrel": 8.0, "ev": 88.5}

    def _resolve_sp(ovr_name, fallback_team, date_str):
        """Return (sp_name, career_stats_dict). Uses ESPN probable name when provided,
        otherwise falls back to the cross-lookup in daily_lineups (the pitcher listed
        on team=X's row is the SP *facing* X, i.e. the opponent's starter).
        When Savant career data is absent, synthesizes stats from pitcher_recent_stats."""
        season = int(date_str[:4])
        if ovr_name:
            if ovr_name in sp_stats:
                return ovr_name, sp_stats[ovr_name]
            low = ovr_name.lower()
            # Exact case-insensitive match
            for k, v in sp_stats.items():
                if k.lower() == low:
                    return k, v
            # Accent-normalized match ("Cristopher Sanchez" → "Cristopher Sánchez")
            norm_ovr = _strip_accents(low)
            for k, v in sp_stats.items():
                if _strip_accents(k.lower()) == norm_ovr:
                    return k, v
            # Last-name fallback — only accept when first initial also matches
            # to avoid wrong-pitcher confusion (e.g. Aaron ≠ Cristopher Sanchez)
            parts = norm_ovr.split()
            ovr_init = parts[0][0] if parts else ''
            ovr_last = parts[-1] if parts else ''
            hits = [(k, v) for k, v in sp_stats.items()
                    if _strip_accents(k.lower()).split()[-1] == ovr_last
                    and _strip_accents(k.lower()).split()[0][:1] == ovr_init]
            if len(hits) == 1:
                return hits[0]
            return ovr_name, _sp_from_recent(ovr_name, season)
        row = q1(conn, f"""
            SELECT pitcher_name FROM {lineup_src}
            WHERE team=? AND game_date=? AND pitcher_name IS NOT NULL LIMIT 1
        """, (fallback_team, date_str))
        name = row["pitcher_name"] if row else None
        return name, sp_stats.get(name) or _sp_from_recent(name, season)

    # Load Vegas moneyline odds for this date — averaged across bookmakers, devigged.
    # Keyed by (home_team, away_team, game_number).
    vegas_odds = {}
    odds_rows = q(conn, """
        SELECT home_team, away_team, game_number,
               AVG(home_prob) as avg_home, AVG(away_prob) as avg_away
        FROM betting_odds
        WHERE game_date = ? AND market = 'h2h'
          AND home_prob IS NOT NULL AND away_prob IS NOT NULL
        GROUP BY home_team, away_team, game_number
    """, (pred_date,))
    for row in odds_rows:
        total = (row["avg_home"] or 0) + (row["avg_away"] or 0)
        if total > 0:
            vegas_odds[(row["home_team"], row["away_team"], row["game_number"])] = \
                row["avg_home"] / total  # devigged true home win probability
    print(f"   Vegas odds loaded for {len(vegas_odds)} game(s)\n")

    results = []
    for m in matchups:
        home, away = m["home"], m["away"]
        try:
            h5  = windows[home].stats(5)
            h15 = windows[home].stats(15)
            h30 = windows[home].stats(30)
            a5  = windows[away].stats(5)
            a15 = windows[away].stats(15)
            a30 = windows[away].stats(30)

            if not h15 or not a15:
                print(f"   Warning: insufficient rolling data for {home} or {away}")
                continue

            home_sp_name, home_sp = _resolve_sp(m.get("home_sp_ovr"), away, date)
            away_sp_name, away_sp = _resolve_sp(m.get("away_sp_ovr"), home, date)

            # Park — use actual home team's stadium (already correct since `home`
            # is resolved from is_home flag). Try current season first, fall back.
            park_row = q1(conn, """
                SELECT park_id FROM game_results
                WHERE home_team=? AND park_id IS NOT NULL
                ORDER BY season DESC, game_date DESC LIMIT 1
            """, (home,))
            park_id    = park_row["park_id"] if park_row else None
            park_rf    = park_facs.get(park_id, 1.0)
            park_hr_f  = get_hr_park_factor(park_id)
            wx_feats   = get_weather_features(wx_map, park_id, date)

            elo_home = current_elo.get(home, 1500)
            elo_away = current_elo.get(away, 1500)

            h_streak = windows[home].streak_stats()
            a_streak = windows[away].streak_stats()
            h_ewm    = windows[home].ewm_rdiff()
            a_ewm    = windows[away].ewm_rdiff()

            feats = build_game_features(
                home, away, None, None,
                h5, h15, h30, a5, a15, a30,
                home_sp, away_sp,
                park_rf, wx_feats, elo_home, elo_away, season,
                game_date=date,
                lineup_stats=todays_lineup_stats,
                lineup_players=todays_lineup_players,
                pitcher_recent=pitcher_recent,
                pitcher_recent_l5=pitcher_recent_l5,
                h2h_map=h2h_map,
                savant_hitters=savant_hitters,
                home_sp_name=home_sp_name,
                away_sp_name=away_sp_name,
                home_streak=h_streak,
                away_streak=a_streak,
                home_ewm_rdiff=h_ewm,
                away_ewm_rdiff=a_ewm,
                sp_season_stats=sp_season_stats,
                hitter_rolling=hitter_rolling,
            )

            X = np.array([[feats.get(c, np.nan) for c in feature_cols]], dtype=float)
            prob     = float(winner_model.predict_proba(X)[0][1])
            run_pred = float(run_model.predict(X)[0])
            # Shrink raw GBM output toward 50% — GBM is systematically overconfident.
            prob = 0.5 + (prob - 0.5) * 0.75
            model_prob = prob  # dampened model-only probability

            gnum = m.get("game_number", 1)
            vegas_home = vegas_odds.get((home, away, gnum))
            if vegas_home is None:
                # Try alternate game_number keys (ESPN vs OddsAPI may differ by 1)
                for alt in [1, 2]:
                    if (home, away, alt) in vegas_odds:
                        vegas_home = vegas_odds[(home, away, alt)]
                        break

            # Edge = model vs Vegas disagreement. Vegas is NOT blended into the pick —
            # blending compressed model conviction and degraded accuracy (May 6-11: same_side=0
            # went 2-0 while same_side=1 went 7-10, showing model signal is more useful alone).
            edge = (model_prob - vegas_home) if vegas_home is not None else None

            # Pick and confidence come from the model only.
            prob = model_prob
            conf = max(prob, 1 - prob)

            # Blend HR park factor into projected total (HRs drive ~30% of run scoring)
            hr_adj      = 1.0 + (park_hr_f - 1.0) * 0.30
            run_total_adj = run_pred * hr_adj

            # Analytical SP quality correction — pulls the model prediction toward
            # the true ace-vs-ace or bad-pitcher outcome that the GBR may underfit.
            # Uses L5 ERA (75%) + season ERA (25%) as the effective SP quality signal.
            h_era_eff = feats.get("home_sp_era_l5", feats["home_sp_era"]) * 0.75 + feats["home_sp_era"] * 0.25
            a_era_eff = feats.get("away_sp_era_l5", feats["away_sp_era"]) * 0.75 + feats["away_sp_era"] * 0.25
            combined_era = h_era_eff + a_era_eff
            # K9 L5 (how many Ks combined this week — suppresses scoring)
            combined_k9 = (feats.get("home_sp_k9_l5", feats.get("home_sp_recent_k9", 8.5))
                           + feats.get("away_sp_k9_l5", feats.get("away_sp_recent_k9", 8.5)))
            # ERA correction: lg-avg combined ERA ≈ 8.40 (two ~4.20 ERAs).
            # Each 1-run deviation from avg = ~0.28 projected runs shift.
            sp_era_adj = (combined_era - 8.40) * 0.28
            # K9 correction: league avg combined K9 ≈ 17.0 (two ~8.5 K9).
            # Each 1.0 K9 above avg suppresses ~0.05 runs.
            sp_k9_adj  = (17.0 - combined_k9) * 0.05
            sp_run_adj = max(-2.0, min(2.0, sp_era_adj + sp_k9_adj))
            run_total_adj = run_total_adj + sp_run_adj

            same_side = None
            if vegas_home is not None:
                same_side = (model_prob >= 0.5) == (vegas_home >= 0.5)

            results.append({
                "home":              home,
                "away":              away,
                "game_number":       m.get("game_number", 1),
                "home_prob":         prob,        # model probability (no Vegas blend)
                "away_prob":         1 - prob,
                "model_home_prob":   model_prob,  # dampened model-only
                "vegas_home_prob":   vegas_home,  # devigged Vegas implied (None if unavailable)
                "edge":              edge,         # model - vegas (pos = model likes home more)
                "same_side":         same_side,   # True when model & Vegas agree on winner
                "run_total":         run_total_adj,
                "conf":              conf,
                "pick":              home if prob >= 0.5 else away,
                "home_sp":           home_sp_name or "Unknown",
                "away_sp":           away_sp_name or "Unknown",
                "home_era":          feats["home_sp_era"],
                "away_era":          feats["away_sp_era"],
                "park":              park_id or "?",
                "park_hr_factor":    park_hr_f,
                "temp_f":            wx_feats["temp_f"],
                "wind_out":          wx_feats["wind_out"],
                "home_rdiff_15":     feats["home_rdiff_15"],
                "away_rdiff_15":     feats["away_rdiff_15"],
                "home_wpct_15":      feats["home_wpct_15"],
                "away_wpct_15":      feats["away_wpct_15"],
                "home_win_streak":   int(feats["home_win_streak"]),
                "away_win_streak":   int(feats["away_win_streak"]),
                "home_loss_streak":  int(feats["home_loss_streak"]),
                "away_loss_streak":  int(feats["away_loss_streak"]),
                "home_wpct_trend":   round(feats["home_wpct_trend"], 3),
                "away_wpct_trend":   round(feats["away_wpct_trend"], 3),
                "home_ewm_rdiff":    round(feats["home_ewm_rdiff"], 2),
                "away_ewm_rdiff":    round(feats["away_ewm_rdiff"], 2),
                "home_rdiff_30":     round(feats["home_rdiff_30"], 2),
                "away_rdiff_30":     round(feats["away_rdiff_30"], 2),
                "home_wpct_30":      round(feats["home_wpct_30"], 3),
                "away_wpct_30":      round(feats["away_wpct_30"], 3),
                "home_lineup_ops":   round(feats["home_lineup_ops"], 3),
                "away_lineup_ops":   round(feats["away_lineup_ops"], 3),
                "home_sp_era_l5":    round(feats.get("home_sp_era_l5", feats["home_sp_era"]), 2),
                "away_sp_era_l5":    round(feats.get("away_sp_era_l5", feats["away_sp_era"]), 2),
            })

        except Exception as e:
            results.append({"home": home, "away": away, "error": str(e)})

    conn.close()
    # Sort by game_number first so that game 1 always precedes game 2 in the output.
    results.sort(key=lambda x: (x.get("game_number", 1), -(x.get("conf") or 0)))

    mark = lambda r: "<" if r["pick"] == r["home"] else ">"
    def _edge_tag(r):
        e = r.get("edge")
        ss = r.get("same_side")
        if e is None: return "  n/a "
        tag = "✓" if ss else "✗"
        sign = "+" if e >= 0 else ""
        return f"{tag}{sign}{e*100:4.1f}%"

    all_picks = [r for r in results if "error" not in r]

    print(f"   {'MATCHUP':<22} {'MDL%':>6} {'VGS%':>6} {'EDGE':>8} {'PICK':<7} {'CONF':>6} {'TOTAL':>6}")
    print("   " + "-"*78)
    for r in all_picks:
        matchup = f"{r['away']} @ {r['home']}"
        mdl_h   = r["model_home_prob"] * 100
        vgs_h   = r["vegas_home_prob"] * 100 if r["vegas_home_prob"] is not None else float("nan")
        print(f"   {matchup:<22} {mdl_h:>5.1f}% "
              f"{vgs_h:>5.1f}%  {_edge_tag(r):>8}  "
              f"{r['pick']:<7}{mark(r)} {r['conf']*100:>5.1f}% {r['run_total']:>5.1f}")
    print()

    import json as _json
    print("PREDSJSON:" + _json.dumps([{
        "date":          date,
        "home":          r["home"],
        "away":          r["away"],
        "game_number":   r.get("game_number", 1),
        "home_prob":     round(r["home_prob"] * 100, 2),
        "away_prob":     round(r["away_prob"] * 100, 2),
        "pick":          r["pick"],
        "confidence":    round(r["conf"] * 100, 2),
        "proj_total":    round(r["run_total"], 2),
        "home_sp":       r.get("home_sp"),
        "away_sp":       r.get("away_sp"),
        "model_prob":    round(r["model_home_prob"] * 100, 2),
        "vegas_implied": round(r["vegas_home_prob"] * 100, 2) if r["vegas_home_prob"] is not None else None,
        "edge":          round(r["edge"] * 100, 2) if r["edge"] is not None else None,
        "same_side":     r.get("same_side"),
        "home_era":      round(r.get("home_era", 4.20), 2),
        "away_era":      round(r.get("away_era", 4.20), 2),
        "home_sp_era_l5":    r.get("home_sp_era_l5"),
        "away_sp_era_l5":    r.get("away_sp_era_l5"),
        # Use L15 window for reasoning (more responsive than L30 for hot/cold detection)
        "home_rdiff_30": r.get("home_rdiff_15"),
        "away_rdiff_30": r.get("away_rdiff_15"),
        "home_wpct_30":  r.get("home_wpct_15"),
        "away_wpct_30":  r.get("away_wpct_15"),
        "home_lineup_ops": r.get("home_lineup_ops"),
        "away_lineup_ops": r.get("away_lineup_ops"),
        "home_win_streak":  r.get("home_win_streak", 0),
        "away_win_streak":  r.get("away_win_streak", 0),
        "home_loss_streak": r.get("home_loss_streak", 0),
        "away_loss_streak": r.get("away_loss_streak", 0),
    } for r in all_picks]))
    return results

# -------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train",   action="store_true")
    parser.add_argument("--predict", action="store_true")
    parser.add_argument("--date",    default=None, help="Override prediction date (YYYY-MM-DD)")
    args = parser.parse_args()

    if not args.train and not args.predict:
        print("Usage: python predictorv4.py --train --predict")
        return

    winner_model = run_model = feature_cols = None

    if args.train:
        conn = get_db()
        elo_history, current_elo = compute_elo(conn)
        conn.close()

        df, feature_cols = build_training_data(elo_history)
        winner_model, run_model, feature_cols, metrics = train_models(df, feature_cols)

        with open(MODEL_PATH, "wb") as f:
            pickle.dump({
                "winner": winner_model,
                "run":    run_model,
                "feats":  feature_cols,
                "metrics": metrics
            }, f)
        with open(FEATURES_PATH, "w") as f:
            json.dump({"feature_cols": feature_cols,
                       "trained_at": datetime.now().isoformat(),
                       **metrics}, f, indent=2)
        print(f"\n[OK] Models saved -> {MODEL_PATH}")

    if args.predict:
        if not winner_model:
            if not MODEL_PATH.exists():
                print("[ERROR] No model. Run --train first.")
                return
            with open(MODEL_PATH, "rb") as f:
                saved = pickle.load(f)
            winner_model  = saved["winner"]
            run_model     = saved["run"]
            feature_cols  = saved["feats"]

        with open(ELO_PATH) as f:
            current_elo = json.load(f)

        predict_today(winner_model, run_model, feature_cols, current_elo,
                      date_override=args.date)

if __name__ == "__main__":
    main()