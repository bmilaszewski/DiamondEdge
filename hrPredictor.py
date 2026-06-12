"""
homerun_predictor.py

Advanced Home Run Prediction Model
===================================

Predicts home run likelihood by analyzing:
1. Pitcher's HR rate by pitch type (HR/9, HR%)
2. Pitcher's barrel%, exit velocity allowed, launch angle
3. Hitter's HR rate vs specific pitch types
4. Hitter's barrel%, exit velocity, launch angle vs those pitches
5. Park factors (some parks favor HRs)
6. Weather conditions (wind, temperature)

USAGE:
  python homerun_predictor.py --train
  python homerun_predictor.py --predict
  python homerun_predictor.py --train --predict
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
elif sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import argparse
import json
import pickle
import sqlite3
import sys
import warnings
from datetime import datetime
from pathlib import Path
import math
import urllib.request
import urllib.error

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import (accuracy_score, precision_score, recall_score,
                              roc_auc_score, mean_absolute_error, r2_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

DB_PATH = Path(__file__).parent / "mlb.db"
MODEL_PATH = Path(__file__).parent / "homerun_model.pkl"
FEATURES_PATH = Path(__file__).parent / "homerun_features.json"

# MLB averages for reference
MLB_AVG_HR_RATE = 1.3  # HR per game per team
MLB_AVG_BARREL_PCT = 8.0
MLB_AVG_EXIT_VELO = 88.0
MLB_AVG_LAUNCH_ANGLE = 12.0

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = lambda cursor, row: {
        col[0]: row[idx] for idx, col in enumerate(cursor.description)
    }
    return conn

def q(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()

def q1(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()

def safe(v, default=None):
    if v is None: return default
    try:
        f = float(v)
        return default if np.isnan(f) else f
    except:
        return default

_LG_AVG_VULN = None  # lazy singleton

def _league_avg_vuln():
    global _LG_AVG_VULN
    if _LG_AVG_VULN is None:
        _LG_AVG_VULN = {
            "overall_hr_rate":      0.034,
            "overall_pa":           0,
            "overall_barrel_pct":   MLB_AVG_BARREL_PCT,
            "overall_exit_velo":    MLB_AVG_EXIT_VELO,
            "overall_launch_angle": MLB_AVG_LAUNCH_ANGLE,
            "overall_hard_hit_pct": 35.0,
            "overall_whiff_pct":    25.0,
            "pitch_mix":            {},
        }
    return _LG_AVG_VULN

def get_pitcher_hr_vulnerability(conn, pitcher_mlb_id, year):
    """
    Get pitcher's home run vulnerability by pitch type.
    Returns metrics like HR%, barrel%, exit velocity, launch angle for each pitch.
    Falls back to league-average profile for pitchers with no Statcast data.
    """
    # Get overall pitcher stats
    overall = q1(conn, """
        SELECT home_run, pa, barrel_batted_rate, exit_velocity_avg,
               launch_angle_avg, hard_hit_percent, whiff_percent
        FROM savant_pitcher_stats
        WHERE mlb_id = ? AND season <= ?
        ORDER BY season DESC LIMIT 1
    """, (pitcher_mlb_id, year))

    if not overall:
        return _league_avg_vuln()

    # Get pitch-type specific data
    pitch_types = q(conn, """
        SELECT pitch_type, pitch_name, pitches, pa, run_value,
               woba, xwoba, whiff_percent, put_away_percent
        FROM pitcher_pitch_type
        WHERE mlb_id = ? AND year <= ?
        ORDER BY year DESC, pitches DESC
    """, (pitcher_mlb_id, year))

    if not pitch_types:
        return _league_avg_vuln()

    total_pitches = sum(safe(p["pitches"], 0) for p in pitch_types)

    if total_pitches == 0:
        return _league_avg_vuln()
    
    overall_pa = max(safe(overall["pa"], 1), 1)
    result = {
        "overall_hr_rate": safe(overall["home_run"], 0) / overall_pa,
        "overall_pa":      overall_pa,
        "overall_barrel_pct": safe(overall["barrel_batted_rate"], MLB_AVG_BARREL_PCT),
        "overall_exit_velo": safe(overall["exit_velocity_avg"], MLB_AVG_EXIT_VELO),
        "overall_launch_angle": safe(overall["launch_angle_avg"], MLB_AVG_LAUNCH_ANGLE),
        "overall_hard_hit_pct": safe(overall["hard_hit_percent"], 35.0),
        "overall_whiff_pct": safe(overall.get("whiff_percent"), 25.0),
        "pitch_mix": {}
    }
    
    # Calculate per-pitch metrics
    for p in pitch_types:
        pitch_type = p["pitch_type"]
        if not pitch_type or safe(p["pitches"], 0) == 0:
            continue
        
        usage_pct = safe(p["pitches"], 0) / total_pitches
        
        # Estimate HR rate from run_value and woba
        # Higher woba/xwoba and positive run_value = more HRs allowed
        woba = safe(p["woba"], 0.320)
        xwoba = safe(p["xwoba"], 0.320)
        
        # Rough HR estimation: woba > 0.400 suggests HR potential
        # Scale: .300 woba = 0.01 HR rate, .400 woba = 0.05 HR rate
        estimated_hr_rate = max(0, (woba - 0.280) * 0.10)
        
        result["pitch_mix"][pitch_type] = {
            "usage_pct": usage_pct,
            "woba": woba,
            "xwoba": xwoba,
            "estimated_hr_rate": estimated_hr_rate,
            "pitches": safe(p["pitches"], 0),
        }
    
    return result

def get_hitter_hr_power(conn, hitter_mlb_id, year):
    """
    Get hitter's home run power by pitch type.
    Combines pitch-type wOBA/SLG data with season ISO/HR-rate for power proxy.
    Key Statcast HR correlators: barrel%, hard_hit%, exit_velo, launch_angle.
    We estimate these from xwoba, SLG, and ISO where direct Statcast is unavailable.
    """
    pitch_types = q(conn, """
        SELECT pitch_type, pitches, pa, ba, slg,
               woba, xwoba, whiff_percent, put_away_percent, run_value
        FROM hitter_vs_pitch_type
        WHERE mlb_id = ? AND year <= ?
        ORDER BY year DESC
    """, (hitter_mlb_id, year))

    # Season stats for ISO / HR rate
    season_stats = q1(conn, """
        SELECT hr, games, avg, slg, obp, ops
        FROM player_stats
        WHERE mlb_id = ? AND season <= ?
        ORDER BY season DESC LIMIT 1
    """, (hitter_mlb_id, year))

    # Recent stats for hot hand
    recent_stats = q1(conn, """
        SELECT home_runs, at_bats, iso, ops, slg, avg
        FROM hitter_recent_stats
        WHERE mlb_id = ? AND season <= ? AND window = 20
        ORDER BY season DESC LIMIT 1
    """, (hitter_mlb_id, year))

    if not pitch_types:
        return None

    # Derive season-level power metrics
    if season_stats:
        games_played   = max(safe(season_stats["games"], 1), 1)
        hr             = safe(season_stats["hr"], 0)
        season_avg     = safe(season_stats["avg"], 0.250)
        season_slg     = safe(season_stats["slg"], 0.400)
        season_ops     = safe(season_stats["ops"], 0.720)
        # ISO = SLG - AVG (standard definition)
        season_iso     = max(0.0, season_slg - season_avg)
        # HR rate per PA: estimate AB from games (MLB avg ~3.8 AB/game).
        # Using HR/game inflated predictions by ~4x since it was treated as a
        # per-PA probability. Must normalize: HR/PA = HR / (games * 3.8)
        estimated_ab   = max(games_played * 3.8, 1.0)
        season_hr_rate = min(hr / estimated_ab, 0.12)  # cap at 12% per PA
    else:
        season_hr_rate = 0.03
        season_iso     = 0.150
        season_slg     = 0.400
        season_ops     = 0.720

    # Recent power (last 20 games)
    if recent_stats and safe(recent_stats["home_runs"], 0) >= 0:
        r_avg  = safe(recent_stats.get("avg"), season_avg if season_stats else 0.250)
        r_slg  = safe(recent_stats["slg"], season_slg)
        r_iso_raw = recent_stats.get("iso")
        recent_iso    = safe(r_iso_raw, max(0.0, r_slg - r_avg))
        recent_slg    = r_slg
        recent_hr_rate = safe(recent_stats["home_runs"], 0) / max(safe(recent_stats["at_bats"], 1), 1)
    else:
        recent_iso    = season_iso
        recent_slg    = season_slg
        recent_hr_rate = season_hr_rate

    # Barrel% proxy: high xwoba + high ISO ~= barrel potential
    # Empirical: barrel_pct ~= 22 * ISO - 0.4  (rough MLB average relationship)
    barrel_proxy = max(0.0, 22.0 * season_iso - 0.4)

    # Hard-hit% proxy: ISO + SLG correlation
    hard_hit_proxy = min(60.0, max(20.0, season_iso * 150.0 + 25.0))

    # Exit-velo proxy (mph): harder hitters have higher ISO
    exit_velo_proxy = min(95.0, max(82.0, season_iso * 50.0 + 85.0))

    # Launch angle proxy: fly-ball hitters have > .200 ISO typically
    launch_angle_proxy = min(20.0, max(5.0, season_iso * 40.0 + 8.0))

    result = {}
    for p in pitch_types:
        pt = p["pitch_type"]
        # Use most recent year only (query is ORDER BY year DESC so first row wins)
        if not pt or safe(p["pitches"], 0) < 10 or pt in result:
            continue

        slg   = safe(p["slg"],   0.400)
        woba  = safe(p["woba"],  0.320)
        xwoba = safe(p["xwoba"], 0.320)
        whiff = safe(p["whiff_percent"], 25.0)

        # HR rate estimate: blend pitch-level woba with season HR rate
        # xwoba > .380 strongly correlates with extra-base power
        pitch_hr_estimate = max(0.0,
            (xwoba - 0.280) * 0.12   +   # xwoba component
            season_hr_rate * 0.50        # season HR rate component
        )

        # Barrel potential for this pitch type
        pitch_barrel = max(0.0, barrel_proxy * (xwoba / max(0.320, woba)))

        # Contact quality: make contact + high xwoba = barreling potential
        contact_quality = max(0, (100 - whiff) / 100 * xwoba)

        result[pt] = {
            "slg":               slg,
            "woba":              woba,
            "xwoba":             xwoba,
            "whiff_pct":         whiff,
            "estimated_hr_rate": pitch_hr_estimate,
            "contact_quality":   contact_quality,
            "pitch_barrel_pct":  pitch_barrel,
            "hard_hit_pct":      hard_hit_proxy,
            "exit_velo":         exit_velo_proxy,
            "launch_angle":      launch_angle_proxy,
            "pitches_seen":      safe(p["pitches"], 0),
            # Season power context
            "season_iso":        season_iso,
            "season_hr_rate":    season_hr_rate,
            "season_slg":        season_slg,
            "recent_iso":        recent_iso,
            "recent_slg":        recent_slg,
            "recent_hr_rate":    recent_hr_rate,
        }

    return result if result else None

def calculate_matchup_hr_probability(pitcher_hr_vuln, hitter_hr_power):
    """
    Calculate expected HR probability for this specific matchup.
    
    Algorithm:
    1. For each pitch type the pitcher throws:
       - Get pitcher's HR rate on that pitch
       - Get hitter's HR rate vs that pitch
       - Combine them (weighted average, 60% pitcher / 40% hitter)
       - Weight by how often pitcher throws it
    2. Sum across all pitch types
    """
    if not pitcher_hr_vuln or not hitter_hr_power:
        return 0.03  # League average: ~3% of PA result in HR
    
    total_hr_prob = 0
    
    for pitch_type, pitcher_stats in pitcher_hr_vuln["pitch_mix"].items():
        if pitch_type not in hitter_hr_power:
            # Hitter hasn't seen this pitch much, use league average
            hitter_hr_rate = 0.03
        else:
            hitter_hr_rate = hitter_hr_power[pitch_type]["estimated_hr_rate"]
        
        pitcher_hr_rate = pitcher_stats["estimated_hr_rate"]
        usage = pitcher_stats["usage_pct"]
        
        # Combine pitcher vulnerability and hitter power
        # Give more weight to pitcher (harder to hit HRs off good pitchers)
        combined_hr_rate = pitcher_hr_rate * 0.60 + hitter_hr_rate * 0.40
        
        # Weight by pitch usage
        total_hr_prob += combined_hr_rate * usage
    
    return total_hr_prob

# Park HR factors — empirically derived from 2019-2024 historical_lineups data
# (HR/AB by park_id, regressed toward 1.0 for single-season samples).
# Cross-referenced against known park geometry / altitude effects.
# Biggest revisions from prior static table:
#   LOS03 1.01→1.18 (Dodger Stadium genuinely HR-friendly in Statcast era)
#   DEN02 1.46→1.20 (humidor installed 2002; altitude still matters but much less)
#   SFO03 0.87→0.73 (empirical 0.73x; marine air + deep CF confirmed very suppressive)
#   SAN02 0.93→1.05 (walls moved in 2013; neutral-to-favorable in practice)
#   CHI12 1.06→0.93 (empirical 0.93x; was overrated)
#   CHI11 0.96→0.86 (empirical 0.86x; overall suppressor despite famous wind days)
#   MIL06 1.04→1.11 (empirical 1.11x)
#   NYC20 0.98→1.08 (empirical 1.11x; blended conservatively)
#   ANA01 0.99→1.08 (empirical 1.11x; blended conservatively)
PARK_HR_FACTORS = {
    "NYC21": 1.21,   # Yankee Stadium — empirical 1.21x; short RF porch confirmed
    "LOS03": 1.18,   # Dodger Stadium — empirical 1.26x; blended conservatively
    "HOU03": 1.14,   # Minute Maid — empirical 1.17x; Crawford Boxes + roof
    "CIN09": 1.14,   # GABP — empirical and prior sources agree
    "BAL12": 1.11,   # Camden Yards — empirical 1.11x
    "MIL06": 1.11,   # American Family Field — empirical 1.11x
    "ANA01": 1.08,   # Angel Stadium — empirical 1.11x; blended
    "NYC20": 1.08,   # Citi Field — empirical 1.11x; blended
    "CLE08": 1.07,   # Progressive Field — empirical 1.10x
    "MIN04": 1.07,   # Target Field — empirical 1.13x; blended
    "DEN02": 1.20,   # Coors Field — altitude still matters; humidor moderates to ~1.05-1.20
    "SAN02": 1.05,   # Petco Park — empirical 1.14x; walls moved in; cautious upgrade
    "PHI13": 1.04,   # Citizens Bank — empirical 1.04x
    "SAC01": 1.04,   # Sutter Health Park (ATH)
    "STL10": 1.02,   # Busch Stadium
    "KAN06": 1.02,   # Kauffman Stadium
    "DET05": 1.00,   # Comerica Park — empirical data absent; neutral
    "ARL03": 1.00,   # Globe Life Field — empirical 1.00x (no strong temp effect inside)
    "PIT08": 1.00,   # PNC Park
    "TOR02": 0.99,   # Rogers Centre — empirical 0.99x
    "STP01": 0.99,   # Tropicana Field
    "TAM02": 0.99,   # Tropicana (alt park_id)
    "ATL03": 0.97,   # Truist Park — empirical 0.93x; blended (altitude ≈1050ft helps some)
    "PHO01": 0.95,   # Chase Field — empirical 0.95x; retractable roof limits heat effect
    "BOS07": 0.95,   # Fenway Park — empirical 0.95x; Green Monster trades HR for doubles
    "MIA02": 0.95,   # loanDepot park — retractable roof
    "SEA03": 0.92,   # T-Mobile Park — empirical 0.92x; marine air
    "CHI12": 0.93,   # Guaranteed Rate — empirical 0.93x (was overrated at 1.06)
    "WAS11": 0.87,   # Nationals Park — empirical 0.87x
    "CHI11": 0.86,   # Wrigley Field — empirical 0.86x overall (famous wind days skew up;
                     # prevailing wind is actually IN from LF, suppressing HRs on avg)
    "SFO03": 0.73,   # Oracle Park — empirical 0.73x; coldest/windiest MLB park; bay wind
}

# Park elevations above sea level (feet).
# Thin air at altitude amplifies temperature carry effect and alters wind dynamics.
# At Coors (5280 ft, ~80% sea-level density) every °F above 70 carries the ball
# proportionally further than at sea level — compounding the already-elevated park factor.
PARK_ELEVATIONS = {
    "DEN02": 5280,  # Coors Field — dominant effect; altitude alone adds ~10% HR carry
    "PHO01": 1082,  # Chase Field
    "ATL03": 1050,  # Truist Park
    "ARL03":  551,  # Globe Life Field
    "KAN06":  750,  # Kauffman Stadium
    "STL10":  466,  # Busch Stadium
    "MIN04":  830,  # Target Field
    "SAC01":   30,  # Sutter Health Park
}

def compute_hr_park_factors_from_db(conn):
    """
    Compute HR park factors from historical_lineups + game_results + game_weather.

    Methodology:
    - Join all three tables on (park_id, game_date) to get per-game HR rates
    - Compute raw park HR rate vs league average
    - Weather-normalize: bin games by temperature and wind-out alignment so that
      a park's factor isn't inflated by coincidentally favorable weather
    - Apply Bayesian regression toward 1.0 for small samples
    - Returns dict keyed by park_id
    """
    # Pull per-game HR totals with weather context for normalization
    rows = conn.execute("""
        SELECT g.park_id,
               SUM(h.home_runs)                        AS total_hr,
               SUM(h.at_bats)                          AS total_ab,
               AVG(COALESCE(w.temperature_f,  72.0))   AS avg_temp,
               AVG(COALESCE(w.wind_speed_mph,  0.0))   AS avg_wind
        FROM historical_lineups h
        JOIN game_results g
          ON  h.game_date = g.game_date
          AND (g.home_team = h.team OR g.away_team = h.team)
          AND (g.home_team = h.opponent OR g.away_team = h.opponent)
        LEFT JOIN game_weather w
          ON  w.park_id   = g.park_id
          AND w.game_date = REPLACE(h.game_date, '-', '')
        WHERE h.season >= 2021
          AND h.at_bats > 0
          AND g.park_id IS NOT NULL
        GROUP BY g.park_id
        HAVING total_ab >= 300
    """).fetchall()

    total_hr = sum(r["total_hr"] for r in rows if r["total_hr"])
    total_ab = sum(r["total_ab"] for r in rows if r["total_ab"])
    if total_ab == 0:
        return {}

    league_rate = total_hr / total_ab

    # Compute a simple temperature-run multiplier for normalization:
    # parks in warm climates have naturally higher HR rates from temperature alone.
    # Subtract ~0.5% per 10°F above 72°F league average before comparing parks.
    league_avg_temp = 72.0

    factors = {}
    for r in rows:
        park_id = r["park_id"]
        hr      = safe(r["total_hr"], 0)
        ab      = safe(r["total_ab"], 0)
        if ab <= 0 or not park_id:
            continue

        # Weather-normalize: back out temperature inflation so park factor
        # reflects dimensions/altitude rather than climate
        avg_temp = safe(r["avg_temp"], league_avg_temp)
        temp_inflation = 1.0 + ((avg_temp - league_avg_temp) / 10.0) * 0.010
        normalized_hr_rate = (hr / ab) / max(temp_inflation, 0.85)

        raw = normalized_hr_rate / league_rate

        # Bayesian regression toward 1.0: need 3000 AB for full weight
        regression = min(1.0, ab / 3000.0)
        factors[park_id] = 1.0 + (raw - 1.0) * regression

    return factors


def get_park_hr_factor(conn, park_id, home_team, season, _db_cache={}):
    """
    HR park factor for the ACTUAL game stadium.

    Priority:
      1. Savant HR index from park_factors.hr_factor (importSavantParkFactors.js)
      2. Computed from historical_lineups + game_results (DB-native, always available)
      3. Static PARK_HR_FACTORS calibrated fallback
      4. run_factor proxy as last resort

    park_id / home_team must reflect the ACTUAL home team for today's game —
    not the batter's or pitcher's own home park.
    """
    if not park_id and not home_team:
        return 1.0

    # Resolve park_id from home_team if needed
    if not park_id and home_team:
        row = q1(conn, """
            SELECT park_id FROM game_results
            WHERE home_team = ? AND park_id IS NOT NULL
            ORDER BY season DESC, game_date DESC LIMIT 1
        """, (home_team,))
        if row:
            park_id = row["park_id"]

    if not park_id:
        return 1.0

    # 1. Savant HR index from DB (populated by importSavantParkFactors.js)
    pf = q1(conn, """
        SELECT hr_factor FROM park_factors
        WHERE park_id = ? AND hr_factor IS NOT NULL
        ORDER BY season DESC LIMIT 1
    """, (park_id,))
    if pf and pf["hr_factor"] is not None:
        factor = safe(pf["hr_factor"], 1.0)
        if 0.5 < factor < 2.0:
            return factor

    # 2. DB-computed from historical_lineups (always available once data is imported)
    if "db" not in _db_cache:
        _db_cache["db"] = compute_hr_park_factors_from_db(conn)
    db_factors = _db_cache["db"]
    if park_id in db_factors:
        f = db_factors[park_id]
        if 0.5 < f < 2.0:
            return f

    # 3. Static calibrated fallback
    if park_id in PARK_HR_FACTORS:
        return PARK_HR_FACTORS[park_id]

    # 4. run_factor proxy
    rf_row = q1(conn, """
        SELECT AVG(run_factor) as avg_rf
        FROM park_factors
        WHERE park_id = ? AND season >= 2015 AND run_factor IS NOT NULL
    """, (park_id,))
    if rf_row and rf_row["avg_rf"]:
        rf = safe(rf_row["avg_rf"], 100.0) / 100.0
        return max(0.80, min(1.45, 1.0 + (rf - 1.0) * 1.3))

    return 1.0

# ── Park CF orientations (compass bearing from home plate to center field) ──────
# Wind FROM (cf_bearing + 180°) = blowing OUT toward CF = more HRs
# Wind FROM cf_bearing = blowing IN from CF = fewer HRs
# Source: known MLB park geometries
PARK_CF_BEARING = {
    "NYC21": 52,   # Yankee Stadium — CF NE, famous short porch
    "BOS07": 95,   # Fenway Park — CF E
    "CHI11": 45,   # Wrigley Field — CF NE, wind-famous
    "SFO03": 28,   # Oracle Park — CF NNE, bay wind usually blows in from W
    "DEN02": 250,  # Coors Field — CF WSW
    "LOS03": 42,   # Dodger Stadium — CF NE
    "ATL03": 320,  # Truist Park — CF NW
    "ANA01": 20,   # Angel Stadium — CF NNE
    "ARL03": 30,   # Globe Life Field — CF NNE
    "BAL12": 75,   # Camden Yards — CF ENE
    "CHI12": 10,   # Guaranteed Rate — CF N
    "CIN09": 35,   # GABP — CF NNE
    "CLE08": 15,   # Progressive Field — CF N
    "DET05": 220,  # Comerica Park — CF SW
    "KAN06": 50,   # Kauffman — CF NE
    "NYC20": 15,   # Citi Field — CF N
    "SAC01": 30,   # Sutter Health Park — CF NNE
    "OAK01": 30,   # Oakland Coliseum — CF NNE
    "PHI13": 50,   # Citizens Bank — CF NE
    "PIT08": 250,  # PNC Park — CF WSW (Allegheny River beyond CF)
    "SAN02": 10,   # Petco Park — CF N (marine layer from W usually blows in)
    "STL10": 50,   # Busch Stadium — CF NE
    "TEX":   30,   # Globe Life — CF NNE
    "TOR02": 50,   # Rogers Centre — dome, CF NE
    "WAS11": 15,   # Nationals Park — CF N
}

# Park coordinates (lat, lon) used to fetch live NWS weather
PARK_COORDINATES = {
    "NYC21": (40.8296, -73.9262),   # Yankee Stadium
    "BOS07": (42.3467, -71.0972),   # Fenway Park
    "CHI11": (41.9484, -87.6553),   # Wrigley Field
    "CHI12": (41.8299, -87.6338),   # Guaranteed Rate Field
    "SFO03": (37.7786, -122.3893),  # Oracle Park
    "DEN02": (39.7560, -104.9941),  # Coors Field
    "LOS03": (34.0739, -118.2400),  # Dodger Stadium
    "ATL03": (33.8907, -84.4677),   # Truist Park
    "ANA01": (33.8003, -117.8827),  # Angel Stadium
    "ARL03": (32.7512, -97.0832),   # Globe Life Field
    "BAL12": (39.2838, -76.6218),   # Camden Yards
    "CIN09": (39.0974, -84.5082),   # Great American Ball Park
    "CLE08": (41.4962, -81.6852),   # Progressive Field
    "DET05": (42.3390, -83.0485),   # Comerica Park
    "HOU03": (29.7573, -95.3555),   # Minute Maid Park
    "KAN06": (39.0517, -94.4803),   # Kauffman Stadium
    "MIN04": (44.9817, -93.2775),   # Target Field
    "MIA02": (25.7781, -80.2197),   # loanDepot Park
    "MIL06": (43.0280, -87.9712),   # American Family Field
    "NYC20": (40.7571, -73.8458),   # Citi Field
    "OAK01": (37.7516, -122.2005),  # Oakland Coliseum
    "PHI13": (39.9061, -75.1665),   # Citizens Bank Park
    "PHO01": (33.4453, -112.0667),  # Chase Field
    "PIT08": (40.4469, -80.0058),   # PNC Park
    "SAC01": (38.5758, -121.5085),  # Sutter Health Park
    "SAN02": (32.7073, -117.1566),  # Petco Park
    "SEA03": (47.5914, -122.3325),  # T-Mobile Park
    "STL10": (38.6226, -90.1928),   # Busch Stadium
    "TAM02": (27.7682, -82.6534),   # Tropicana Field
    "STP01": (27.7682, -82.6534),   # Tropicana Field (alt)
    "TOR02": (43.6414, -79.3894),   # Rogers Centre
    "WAS11": (38.8730, -77.0074),   # Nationals Park
}

_NWS_CACHE: dict = {}   # {(park_id, game_date): weather_dict | None}

# Dome parks where weather is irrelevant (controlled environment)
DOME_PARKS_WEATHER = {
    "TAM02", "STP01",  # Tropicana
    "MIA02",           # loanDepot (retractable, usually closed)
    "PHO01",           # Chase Field (retractable, usually closed in heat)
    "MIL06",           # American Family (retractable)
    "SEA03",           # T-Mobile (retractable)
    "TOR02",           # Rogers Centre (dome)
    "HOU03",           # Minute Maid (retractable, usually closed in heat)
    "TOK01",           # Tokyo Dome
}


def compass_to_degrees(direction: str) -> int:
    """Convert compass direction string to meteorological degrees (wind FROM direction)."""
    mapping = {
        "N": 0, "NNE": 22, "NE": 45, "ENE": 67, "E": 90,
        "ESE": 112, "SE": 135, "SSE": 157, "S": 180,
        "SSW": 202, "SW": 225, "WSW": 247, "W": 270,
        "WNW": 292, "NW": 315, "NNW": 337,
    }
    return mapping.get(str(direction).upper().strip(), 180)


def fetch_nws_weather(park_id: str, game_date: str, game_hour_local: int = 19):
    """
    Fetch gametime weather from the NWS hourly forecast API.

    Two-step: api.weather.gov/points/{lat},{lon} → forecastHourly URL → hourly periods.
    Targets game_hour_local (default 19 = 7 PM) in EDT (UTC-4, used Apr-Oct).
    Returns dict(temperature_f, wind_speed_mph, wind_direction, weather_condition) or None.
    wind_speed_mph = sustained wind, NOT gusts. wind_direction = degrees FROM that bearing.
    Results cached in _NWS_CACHE to avoid repeat API calls within a session.
    """
    import json as _json
    import re as _re
    from datetime import datetime, timezone, timedelta

    coords = PARK_COORDINATES.get(park_id)
    if not coords:
        return None

    cache_key = (park_id, game_date)
    if cache_key in _NWS_CACHE:
        return _NWS_CACHE[cache_key]

    lat, lon = coords
    headers = {
        "User-Agent": "MLBHRPredictor/1.0 (bmilaski54@gmail.com)",
        "Accept": "application/geo+json",
    }

    try:
        # Step 1: resolve NWS grid → hourly forecast URL
        points_req = urllib.request.Request(
            f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}", headers=headers)
        with urllib.request.urlopen(points_req, timeout=8) as r:
            points_data = _json.loads(r.read())
        hourly_url = points_data["properties"]["forecastHourly"]

        # Step 2: fetch hourly forecast
        hourly_req = urllib.request.Request(hourly_url, headers=headers)
        with urllib.request.urlopen(hourly_req, timeout=8) as r:
            hourly_data = _json.loads(r.read())

        periods = hourly_data["properties"]["periods"]
        if not periods:
            _NWS_CACHE[cache_key] = None
            return None

        # Identify the period closest to gametime (EDT = UTC-4 during baseball season)
        target_naive = datetime.strptime(game_date, "%Y-%m-%d").replace(
            hour=game_hour_local, minute=0, second=0)
        target_utc = (target_naive - timedelta(hours=-4)).replace(tzinfo=timezone.utc)

        best_period, best_diff = None, float("inf")
        for period in periods:
            start_str = period["startTime"].replace("Z", "+00:00")
            start_utc = datetime.fromisoformat(start_str).astimezone(timezone.utc)
            diff = abs((start_utc - target_utc).total_seconds())
            if diff < best_diff:
                best_diff = diff
                best_period = period

        if not best_period:
            _NWS_CACHE[cache_key] = None
            return None

        # Temperature (NWS returns °F for US parks by default)
        temp_f = float(best_period.get("temperature", 70))
        if best_period.get("temperatureUnit") == "C":
            temp_f = temp_f * 9.0 / 5.0 + 32.0

        # Sustained wind speed (not gusts): "11 mph" or "5 to 10 mph" → take last number
        wind_str = str(best_period.get("windSpeed", "0 mph"))
        wind_nums = _re.findall(r"\d+", wind_str)
        wind_mph = float(wind_nums[-1]) if wind_nums else 0.0

        # Wind direction: "SE" → degrees FROM that bearing (meteorological convention)
        wind_dir_str = str(best_period.get("windDirection", "N"))
        wind_dir_deg = float(compass_to_degrees(wind_dir_str))

        condition = str(best_period.get("shortForecast", ""))

        result = {
            "temperature_f":     temp_f,
            "wind_speed_mph":    wind_mph,
            "wind_direction":    wind_dir_deg,
            "weather_condition": condition,
        }
        _NWS_CACHE[cache_key] = result
        print(f"      [NWS] {park_id} {game_date}: "
              f"{temp_f:.0f}°F, wind {wind_mph:.0f} mph from {wind_dir_str} "
              f"({wind_dir_deg:.0f}°), {condition}")
        return result

    except Exception as exc:
        print(f"      [NWS] fetch failed for {park_id}: {exc}")
        _NWS_CACHE[cache_key] = None
        return None


def _insert_weather_to_db(conn, park_id: str, game_date: str, weather: dict):
    """Cache live NWS weather into game_weather so subsequent queries hit the DB."""
    date_nodash = game_date.replace("-", "")
    try:
        conn.execute("""
            INSERT OR IGNORE INTO game_weather
                (park_id, game_date, temperature_f, wind_speed_mph,
                 wind_direction, weather_condition)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (park_id, date_nodash,
              weather["temperature_f"], weather["wind_speed_mph"],
              weather["wind_direction"], weather["weather_condition"]))
        conn.commit()
    except Exception:
        pass  # non-fatal if game_weather schema differs


def get_weather_hr_factor(conn, park_id, game_date, home_team=None, batter_hand=None):
    """
    Get weather impact on HR probability using park-specific wind orientation.

    Key improvements over naive approach:
    - Wind direction aligned with CF bearing per stadium (not generic N/S)
    - Wind reported from weather stations is often 2x actual field-level speed
      → apply 0.55 correction factor to raw wind speed
    - Temperature effect: ball travels ~1% further per 10°F above 70°F
    - Cold/wet weather (below 50°F, snow/rain) suppresses HRs meaningfully
    - Dome parks return 1.0 regardless
    - Modest effect range: 0.88–1.14 (weather matters but isn't dominant)

    Returns (factor: float, info: dict)
    """
    if not park_id and not home_team:
        return 1.0, {}

    if not park_id and home_team:
        row = q1(conn, """
            SELECT park_id FROM game_results
            WHERE home_team = ? AND park_id IS NOT NULL
            ORDER BY season DESC LIMIT 1
        """, (home_team,))
        if row:
            park_id = row["park_id"]

    if not park_id:
        return 1.0, {}

    if park_id in DOME_PARKS_WEATHER:
        return 1.0, {"note": "dome/retractable — weather neutral"}

    date_nodash = game_date.replace("-", "") if game_date else ""
    weather = None

    # 1. Exact date match in DB (fastest path; also catches previously-fetched NWS data)
    if date_nodash:
        weather = q1(conn, """
            SELECT temperature_f, wind_speed_mph, wind_direction, weather_condition
            FROM game_weather WHERE park_id = ? AND game_date = ?
        """, (park_id, date_nodash))

    # 2. Live NWS API — tried before historical fallbacks so today's game gets
    #    actual gametime conditions, not stale same-date averages from prior years.
    if not weather:
        live = fetch_nws_weather(park_id, game_date)
        if live:
            weather = live
            _insert_weather_to_db(conn, park_id, game_date, live)

    # 3. Historical same-month-day average (useful for training/historical analysis)
    if not weather and date_nodash and len(date_nodash) == 8:
        month_day = date_nodash[4:]
        candidates = q(conn, """
            SELECT temperature_f, wind_speed_mph, wind_direction, weather_condition
            FROM game_weather WHERE park_id = ? AND game_date LIKE ?
            ORDER BY game_date DESC LIMIT 5
        """, (park_id, "%" + month_day))
        if candidates:
            weather = {
                "temperature_f":     sum(safe(r["temperature_f"], 70) for r in candidates) / len(candidates),
                "wind_speed_mph":    sum(safe(r["wind_speed_mph"], 0)  for r in candidates) / len(candidates),
                "wind_direction":    sum(safe(r["wind_direction"], 180) for r in candidates) / len(candidates),
                "weather_condition": candidates[0]["weather_condition"] or "",
            }

    # 4. Any most recent record for this park (last-resort)
    if not weather:
        weather = q1(conn, """
            SELECT temperature_f, wind_speed_mph, wind_direction, weather_condition
            FROM game_weather WHERE park_id = ?
            ORDER BY game_date DESC LIMIT 1
        """, (park_id,))

    if not weather:
        return 1.0, {}

    temp      = safe(weather["temperature_f"],  70.0)
    wind_raw  = safe(weather["wind_speed_mph"],  0.0)
    wind_dir  = safe(weather["wind_direction"], 180.0)
    condition = str(weather.get("weather_condition") or "")

    # ── Elevation context ─────────────────────────────────────────────────
    # Thin air at altitude amplifies temperature carry and slightly changes wind dynamics.
    # At Coors (5280 ft, ~80% sea-level density) every °F above 70 moves the ball
    # proportionally further than at sea level — compounding the park factor.
    # Wind force on the ball is also marginally lower in thin air, but that effect
    # is small vs the dominant altitude carry; we scale temp up, wind slightly down.
    elev_ft      = PARK_ELEVATIONS.get(park_id, 0)
    elev_frac    = elev_ft / 5280.0                  # 0→0 at sea level, 1→1 at Coors
    elev_temp_mult = 1.0 + elev_frac * 0.40         # up to +40% temp effect at Coors
    elev_wind_mult = 1.0 - elev_frac * 0.10         # thin air reduces wind force slightly

    # ── Wind speed correction ──────────────────────────────────────────────
    # Weather station wind speed often 1.5–2× actual field-level speed
    # due to measurement height and stadium windbreak effects.
    wind_spd = wind_raw * 0.55 * elev_wind_mult

    # ── Temperature effect ─────────────────────────────────────────────────
    # Empirical from 2019-2024 data: HR/AB at 85F is ~14% above league, at 50F is ~21%
    # below. Moderate estimate: 3%/10F warm, 2.5%/10F cold (raw empirical is confounded
    # with park selection, so we use ~40% of the raw signal).
    # Reference: 72F (MLB average game-time temp). Altitude amplifies warm carry.
    temp_factor = 1.0
    if temp >= 72:
        temp_factor = 1.0 + ((temp - 72.0) / 10.0) * 0.030 * elev_temp_mult
    elif temp < 65:
        temp_factor = 1.0 - ((65.0 - temp) / 10.0) * 0.025
        if any(w in condition.lower() for w in ("snow", "sleet", "freezing")):
            temp_factor *= 0.95

    # ── Wind direction effect (pull-field aware) ───────────────────────────
    # RHH pull to LF (cf_bearing − 45°); LHH pull to RF (cf_bearing + 45°).
    # When batter_hand is known we align wind to the batter's pull field.
    cf_bearing = PARK_CF_BEARING.get(park_id, 45)
    if batter_hand == "R":
        target_bearing = (cf_bearing - 45) % 360   # LF direction for RHH
    elif batter_hand == "L":
        target_bearing = (cf_bearing + 45) % 360   # RF direction for LHH
    else:
        target_bearing = cf_bearing                 # generic CF when unknown

    wind_factor = 1.0
    if wind_spd >= 2:
        wind_toward = (wind_dir + 180) % 360
        angle_diff  = abs(wind_toward - target_bearing)
        if angle_diff > 180:
            angle_diff = 360 - angle_diff
        alignment = math.cos(math.radians(angle_diff))

        # 10 mph field-level tailwind ≈ +6% HR boost; headwind ≈ -5% suppression
        if alignment > 0:   # tailwind out toward pull field
            wind_factor = 1.0 + alignment * (wind_spd / 10.0) * 0.060
        else:               # headwind into pull field
            wind_factor = 1.0 + alignment * (wind_spd / 10.0) * 0.050

    # ── Rain / precipitation suppression ──────────────────────────────────
    precip_factor = 1.0
    cond_lower = condition.lower()
    if any(w in cond_lower for w in ("rain", "drizzle", "shower", "thunder")):
        precip_factor = 0.97

    # ── Combine and cap ───────────────────────────────────────────────────
    # At altitude parks (especially Coors) the weather factor can legitimately
    # exceed the sea-level ceiling: a 90°F day with 15 mph outward wind at Coors
    # on top of a 1.46 park factor is meaningfully different from a 65°F calm day.
    # Standard parks: cap 0.88–1.14.  High-altitude parks: allow up to 1.20.
    factor     = temp_factor * wind_factor * precip_factor
    cap_high   = 1.20 if elev_ft >= 1000 else 1.14
    cap_low    = 0.88
    factor     = max(cap_low, min(cap_high, factor))

    _wt = (wind_dir + 180) % 360
    _ad = abs(_wt - target_bearing)
    if _ad > 180:
        _ad = 360 - _ad

    info = {
        "temperature_f":        round(temp, 1),
        "wind_speed_raw_mph":   round(wind_raw, 1),
        "wind_speed_field_mph": round(wind_spd, 1),
        "wind_direction":       round(wind_dir, 0),
        "weather_condition":    condition,
        "cf_bearing":           cf_bearing,
        "pull_bearing":         target_bearing,
        "wind_alignment":       round(math.cos(math.radians(_ad)), 2) if wind_spd >= 2 else 0,
        "weather_factor":       round(factor, 3),
    }
    return factor, info

def build_hr_training_data():
    """
    Build training dataset using REAL HR outcomes from historical_lineups.

    Target: did this batter hit a HR in this game? (0/1 per batter-game)
    This eliminates the data-leakage problem where adjusted_hr_prob and
    matchup_hr_prob (derived from each other) dominated all other features.

    Features come from:
      - Pitcher: savant_pitcher_stats (barrel%, hard_hit%, exit_velo, HR rate)
      - Pitcher pitch mix: pitcher_pitch_type (xwoba, woba per pitch)
      - Hitter vs pitch: hitter_vs_pitch_type (slg, xwoba, whiff per pitch)
      - Hitter season: player_stats / hitter_recent_stats (ISO, HR rate, SLG)
      - Park: get_park_hr_factor() — DB-native HR park factor
    """
    print("\n" + "="*62)
    print("  BUILDING HR TRAINING DATA (real outcomes from historical_lineups)")
    print("="*62)

    conn = get_db()

    # Pre-load Statcast hitter metrics for O(1) lookup during training loop
    savant_hitter_map = {}
    for r in q(conn, """
        SELECT mlb_id, season, barrel_batted_rate, exit_velocity_avg,
               hard_hit_percent, launch_angle_avg, xwoba
        FROM savant_hitter_stats WHERE pa >= 50
    """):
        savant_hitter_map[(r["mlb_id"], r["season"])] = r

    # Pre-load career H2H matchup stats (batter vs pitcher, min 5 AB)
    h2h_career_map = {}
    for r in q(conn, """
        SELECT hitter_mlb_id, pitcher_mlb_id,
               SUM(at_bats) as ab, SUM(home_runs) as hr, AVG(ops) as ops
        FROM hitter_vs_pitcher
        GROUP BY hitter_mlb_id, pitcher_mlb_id
        HAVING SUM(at_bats) >= 5
    """):
        h2h_career_map[(r["hitter_mlb_id"], r["pitcher_mlb_id"])] = r

    print(f"   Pre-loaded {len(savant_hitter_map):,} Statcast hitter seasons")
    print(f"   Pre-loaded {len(h2h_career_map):,} career H2H matchup pairs")

    # Get batter-game rows from historical_lineups
    rows_raw = conn.execute("""
        SELECT  h.mlb_id        AS batter_id,
                h.name          AS batter_name,
                h.game_date,
                h.season,
                h.team,
                h.opponent,
                h.at_bats,
                h.home_runs,
                h.pitcher_mlb_id,
                h.pitcher_name,
                g.park_id,
                g.home_team
        FROM historical_lineups h
        LEFT JOIN game_results g
               ON  h.game_date = g.game_date
               AND (g.home_team = h.team OR g.away_team = h.team)
               AND (g.home_team = h.opponent OR g.away_team = h.opponent)
        WHERE h.season >= 2020
          AND h.at_bats >= 2
          AND h.mlb_id IS NOT NULL
          AND h.pitcher_mlb_id IS NOT NULL
        ORDER BY h.game_date
    """).fetchall()

    print(f"   {len(rows_raw):,} batter-game rows from 2020+")

    rows = []
    skipped = 0

    for raw in rows_raw:
        # get_db() sets row_factory → dicts; use key access not index
        batter_id    = raw["batter_id"]
        batter_name  = raw["batter_name"]
        game_date    = raw["game_date"]
        season       = raw["season"]
        team         = raw["team"]
        opponent     = raw["opponent"]
        at_bats      = raw["at_bats"]
        home_runs    = raw["home_runs"]   # ← REAL outcome
        pitcher_id   = raw["pitcher_mlb_id"]
        pitcher_name = raw["pitcher_name"]
        park_id      = raw["park_id"]
        home_team    = raw["home_team"]

        # Real binary target: did they hit a HR this game?
        hit_hr = 1 if (home_runs and home_runs >= 1) else 0

        # ── Pitcher features ─────────────────────────────────────────
        sp = q1(conn, """
            SELECT barrel_batted_rate, exit_velocity_avg, launch_angle_avg,
                   hard_hit_percent, home_run, pa, whiff_percent,
                   oz_swing_percent, k_percent
            FROM savant_pitcher_stats
            WHERE mlb_id = ? AND season <= ?
            ORDER BY season DESC LIMIT 1
        """, (pitcher_id, season))

        if not sp or safe(sp["pa"], 0) < 30:
            skipped += 1
            continue

        pitcher_hr_rate = safe(sp["home_run"], 0) / max(safe(sp["pa"], 1), 1)
        pitcher_barrel  = safe(sp["barrel_batted_rate"], MLB_AVG_BARREL_PCT)
        pitcher_ev      = safe(sp["exit_velocity_avg"],  MLB_AVG_EXIT_VELO)
        pitcher_la      = safe(sp["launch_angle_avg"],   MLB_AVG_LAUNCH_ANGLE)
        pitcher_hh      = safe(sp["hard_hit_percent"],   35.0)
        pitcher_whiff   = safe(sp["whiff_percent"],      25.0)

        # Weighted avg xwoba allowed by pitch type
        pitch_mix = q(conn, """
            SELECT xwoba, woba, pitches
            FROM pitcher_pitch_type
            WHERE mlb_id = ? AND year <= ?
            ORDER BY year DESC, pitches DESC
        """, (pitcher_id, season))

        total_p = sum(safe(p["pitches"], 0) for p in pitch_mix) if pitch_mix else 0
        if total_p > 0:
            pitcher_xwoba_allowed = sum(
                safe(p["xwoba"], 0.320) * safe(p["pitches"], 0) for p in pitch_mix
            ) / total_p
        else:
            pitcher_xwoba_allowed = 0.320

        # ── Hitter features ──────────────────────────────────────────
        # From hitter_vs_pitch_type: weighted avg xwoba, slg, whiff
        hvp = q(conn, """
            SELECT xwoba, slg, whiff_percent, pitches
            FROM hitter_vs_pitch_type
            WHERE mlb_id = ? AND year <= ?
            ORDER BY year DESC
        """, (batter_id, season))

        if hvp:
            total_h = sum(safe(p["pitches"], 0) for p in hvp)
            if total_h > 0:
                hitter_xwoba   = sum(safe(p["xwoba"],         0.320) * safe(p["pitches"], 0) for p in hvp) / total_h
                hitter_slg_pit = sum(safe(p["slg"],           0.400) * safe(p["pitches"], 0) for p in hvp) / total_h
                hitter_whiff   = sum(safe(p["whiff_percent"],  25.0) * safe(p["pitches"], 0) for p in hvp) / total_h
            else:
                hitter_xwoba, hitter_slg_pit, hitter_whiff = 0.320, 0.400, 25.0
        else:
            hitter_xwoba, hitter_slg_pit, hitter_whiff = 0.320, 0.400, 25.0

        # From hitter_recent_stats: ISO, SLG, HR rate
        rs = q1(conn, """
            SELECT iso, slg, home_runs, at_bats, ops
            FROM hitter_recent_stats
            WHERE mlb_id = ? AND window = 20
            ORDER BY season DESC LIMIT 1
        """, (batter_id,))

        if rs and safe(rs["at_bats"], 0) >= 10:
            recent_iso  = safe(rs["iso"],       0.15)
            recent_slg  = safe(rs["slg"],       0.40)
            recent_hr_r = safe(rs["home_runs"], 0) / max(safe(rs["at_bats"], 1), 1)
        else:
            recent_iso = recent_slg = recent_hr_r = 0.0

        # From player_stats: season ISO, HR rate, SLG
        ps = q1(conn, """
            SELECT hr, games, avg, slg, ops
            FROM player_stats
            WHERE mlb_id = ? AND season <= ?
            ORDER BY season DESC LIMIT 1
        """, (batter_id, season))

        if ps and safe(ps["games"], 0) >= 5:
            season_iso  = max(0.0, safe(ps["slg"], 0.40) - safe(ps["avg"], 0.25))
            # HR per PA (not per game) to match get_hitter_hr_power's scale
            season_hr_r = safe(ps["hr"], 0) / max(safe(ps["games"], 1) * 3.8, 1)
            season_slg  = safe(ps["slg"], 0.40)
        else:
            # Fall back to recent stats
            season_iso  = recent_iso
            season_hr_r = recent_hr_r
            season_slg  = recent_slg

        # Real Statcast hitter metrics — barrel%, EV, HH%, launch angle
        # Falls back to ISO-derived proxy only when Statcast data unavailable
        sh = (savant_hitter_map.get((batter_id, season))
              or savant_hitter_map.get((batter_id, season - 1)))
        if sh:
            hitter_barrel = safe(sh["barrel_batted_rate"], max(0.0, 22.0 * season_iso - 0.4))
            hitter_ev     = safe(sh["exit_velocity_avg"],  min(95.0, max(82.0, season_iso * 50.0 + 85.0)))
            hitter_hh     = safe(sh["hard_hit_percent"],   min(60.0, max(20.0, season_iso * 150.0 + 25.0)))
            hitter_la     = safe(sh["launch_angle_avg"],   min(20.0, max(5.0,  season_iso * 40.0 + 8.0)))
        else:
            hitter_barrel = max(0.0, 22.0 * season_iso - 0.4)
            hitter_ev     = min(95.0, max(82.0, season_iso * 50.0 + 85.0))
            hitter_hh     = min(60.0, max(20.0, season_iso * 150.0 + 25.0))
            hitter_la     = min(20.0, max(5.0,  season_iso * 40.0 + 8.0))

        # Career H2H matchup: this batter vs this specific pitcher
        h2h = h2h_career_map.get((batter_id, pitcher_id))
        h2h_ops     = safe(h2h["ops"], 0.720) if h2h else 0.720
        h2h_hr_rate = (safe(h2h["hr"], 0) / max(safe(h2h["ab"], 1), 1)) if h2h else 0.0
        h2h_ab      = safe(h2h["ab"], 0) if h2h else 0.0

        # ── Park factor ──────────────────────────────────────────────
        park_factor = get_park_hr_factor(conn, park_id, home_team, season)

        rows.append({
            # Pitcher
            "pitcher_hr_rate":       pitcher_hr_rate,
            "pitcher_barrel_pct":    pitcher_barrel,
            "pitcher_exit_velo":     pitcher_ev,
            "pitcher_launch_angle":  pitcher_la,
            "pitcher_hard_hit_pct":  pitcher_hh,
            "pitcher_whiff_pct":     pitcher_whiff,
            "pitcher_xwoba_allowed": pitcher_xwoba_allowed,
            # Hitter vs pitch type
            "hitter_xwoba":          hitter_xwoba,
            "hitter_slg_vs_pitch":   hitter_slg_pit,
            "hitter_whiff_pct":      hitter_whiff,
            # Hitter season / recent
            "hitter_season_iso":     season_iso,
            "hitter_season_hr_rate": season_hr_r,
            "hitter_season_slg":     season_slg,
            "hitter_recent_iso":     recent_iso,
            "hitter_recent_slg":     recent_slg,
            "hitter_recent_hr_rate": recent_hr_r,
            # Real Statcast power metrics
            "hitter_barrel_pct":     hitter_barrel,
            "hitter_exit_velo":      hitter_ev,
            "hitter_hard_hit_pct":   hitter_hh,
            "hitter_launch_angle":   hitter_la,
            # Career H2H vs this pitcher
            "hitter_h2h_ops":        h2h_ops,
            "hitter_h2h_hr_rate":    h2h_hr_rate,
            "hitter_h2h_ab":         h2h_ab,
            # Park
            "park_factor":           park_factor,
            # Metadata
            "season":                season,
            "hit_hr":                hit_hr,
        })

    conn.close()

    df = pd.DataFrame(rows)
    hr_rate = df["hit_hr"].mean() * 100
    print(f"   Built {len(df):,} rows  |  skipped {skipped:,}  |  HR rate {hr_rate:.2f}%")
    print(f"   Seasons: {sorted(df['season'].unique().tolist())}")

    if len(df) < 100:
        print("\n   ERROR: Not enough training rows. Run node importHistoricalLineups.js first.")
        import sys; sys.exit(1)

    meta = ["season", "hit_hr"]
    feature_cols = [c for c in df.columns if c not in meta]
    return df, feature_cols


def train_hr_model(df, feature_cols):
    """
    Train HR probability model on real batter-game outcomes.
    Uses GradientBoostingClassifier since target is binary (0/1).
    Calibrated via predict_proba to output usable probabilities.
    """
    print("\n" + "="*62)
    print("  TRAINING HOME RUN MODEL")
    print("="*62)

    X = df[feature_cols].values.astype(float)
    y = df["hit_hr"].values.astype(int)
    n = len(X)
    pos_rate = y.mean()
    print(f"\n  {n:,} samples  |  {len(feature_cols)} features  |  HR rate={pos_rate:.3f}  |  pos={y.sum():,}")

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler",  StandardScaler()),
        ("model",   GradientBoostingClassifier(
            n_estimators=400,
            max_depth=4,
            learning_rate=0.03,
            subsample=0.75,
            min_samples_leaf=40,
            max_features=0.7,
            random_state=42,
        )),
    ])

    max_splits = min(5, max(2, n // 200))
    tscv = TimeSeriesSplit(n_splits=max_splits)
    aucs, accs = [], []

    print(f"\n  CV splits={max_splits}")
    for fold, (tr, va) in enumerate(tscv.split(X), 1):
        if len(va) < 10: continue
        pipeline.fit(X[tr], y[tr])
        probs = pipeline.predict_proba(X[va])[:, 1]
        try:
            auc = roc_auc_score(y[va], probs)
        except Exception:
            auc = 0.5
        acc = accuracy_score(y[va], probs >= 0.05)   # threshold for HR
        aucs.append(auc); accs.append(acc)
        print(f"  Fold {fold}: AUC={auc:.4f}  Acc={acc:.4f}  HR-rate={y[va].mean():.3f}  (n={len(va):,})")

    if aucs:
        print(f"\n  Mean AUC={np.mean(aucs):.4f}  Acc={np.mean(accs):.4f}")

    print("\n  Fitting final model on all data...")
    pipeline.fit(X, y)

    imps = pipeline.named_steps["model"].feature_importances_
    print("\n  Feature Importances:")
    for feat, imp in sorted(zip(feature_cols, imps), key=lambda x: -x[1]):
        bar = "█" * int(imp * 200)
        print(f"    {feat:<40} {imp:.4f}  {bar}")

    return pipeline, feature_cols, {
        "cv_auc_mean":  float(np.mean(aucs))  if aucs else None,
        "cv_acc_mean":  float(np.mean(accs))  if accs else None,
        "n_training":   n,
        "hr_rate":      float(pos_rate),
    }

def predict_today_homeruns(date_override=None):
    """Predict home run probabilities for today's games."""
    print("\n" + "="*60)
    print("  TODAY'S HOME RUN PREDICTIONS")
    print("="*60)

    conn = get_db()
    today = datetime.now().strftime("%Y-%m-%d")
    lineup_src = "historical_lineups" if (date_override and date_override < today) else "daily_lineups"
    pred_date  = date_override or today

    # Pre-load Statcast hitter metrics and H2H career stats for O(1) lookups
    savant_hitter_map = {}
    for r in q(conn, """
        SELECT mlb_id, season, barrel_batted_rate, exit_velocity_avg,
               hard_hit_percent, launch_angle_avg, xwoba, pa
        FROM savant_hitter_stats WHERE pa >= 50
    """):
        savant_hitter_map[(r["mlb_id"], r["season"])] = r

    h2h_career_map = {}
    for r in q(conn, """
        SELECT hitter_mlb_id, pitcher_mlb_id,
               SUM(at_bats) as ab, SUM(home_runs) as hr, AVG(ops) as ops
        FROM hitter_vs_pitcher
        GROUP BY hitter_mlb_id, pitcher_mlb_id
        HAVING SUM(at_bats) >= 5
    """):
        h2h_career_map[(r["hitter_mlb_id"], r["pitcher_mlb_id"])] = r

    # Get games for the target date
    games = q(conn, f"""
        SELECT DISTINCT team, opponent, game_date, season
        FROM {lineup_src}
        WHERE game_date = ? AND batting_order > 0
    """, (pred_date,))

    if not games and lineup_src == "daily_lineups":
        # Try most recent date
        latest = q1(conn, "SELECT MAX(game_date) as d FROM daily_lineups WHERE batting_order > 0")
        if latest and latest["d"]:
            games = q(conn, """
                SELECT DISTINCT team, opponent, game_date, season
                FROM daily_lineups
                WHERE game_date = ? AND batting_order > 0
            """, (latest["d"],))
            print(f"   (Using {latest['d']} - no lineups for today)\n")

    if not games:
        print(f"   [ERROR] No lineup data for {pred_date}.")
        conn.close()
        return
    
    date = games[0]["game_date"]
    season = games[0]["season"]
    print(f"   Date: {date}\n")
    
    all_predictions = []

    for game in games:
        team     = game["team"]
        opponent = game["opponent"]

        # -- Determine home team to resolve correct park ------------------
        # Try is_home column (set by updated scraper); fall back to game_results
        home_team = None
        try:
            # Check if THIS team has is_home=1; if not, the opponent is home
            ht_row = q1(conn, f"""
                SELECT is_home FROM {lineup_src}
                WHERE game_date = ? AND team = ? AND batting_order > 0 LIMIT 1
            """, (date, team))
            if ht_row and ht_row.get("is_home") is not None:
                home_team = team if ht_row["is_home"] else opponent
        except Exception:
            pass

        if not home_team:
            gr = q1(conn, """
                SELECT home_team FROM game_results
                WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)
                ORDER BY game_date DESC LIMIT 1
            """, (team, opponent, opponent, team))
            home_team = gr["home_team"] if gr else team

        # -- Resolve park_id from home team -------------------------------
        park_row = q1(conn, """
            SELECT park_id FROM game_results
            WHERE home_team = ? AND season = ? AND park_id IS NOT NULL
            ORDER BY game_date DESC LIMIT 1
        """, (home_team, season))
        if not park_row:
            park_row = q1(conn, """
                SELECT park_id FROM game_results
                WHERE home_team = ? AND park_id IS NOT NULL
                ORDER BY season DESC LIMIT 1
            """, (home_team,))
        park_id = park_row["park_id"] if park_row else None

        # -- Park factor (game-level; same for all batters in this game) ---
        park_factor = get_park_hr_factor(conn, park_id, home_team, season)

        # -- Get lineup (batters for THIS team) ---------------------------
        lineup = q(conn, f"""
            SELECT mlb_id, name, batting_order, handedness
            FROM {lineup_src}
            WHERE team = ? AND game_date = ? AND batting_order > 0
            ORDER BY batting_order
        """, (team, date))

        if not lineup:
            continue

        # -- Get opposing pitcher -----------------------------------------
        # daily_lineups.pitcher_mlb_id on a HITTER row = the SP that hitter FACES.
        # So for team X's batters, pitcher_mlb_id is the OPPONENT's SP.
        # We can read it directly from team X's hitter rows.
        pitcher_row = q1(conn, f"""
            SELECT pitcher_mlb_id, pitcher_name, pitcher_handedness
            FROM {lineup_src}
            WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL
              AND batting_order > 0
            LIMIT 1
        """, (team, date))

        if not pitcher_row or not pitcher_row["pitcher_mlb_id"]:
            # Fallback: read opponent's pitcher row
            pitcher_row = q1(conn, f"""
                SELECT pitcher_mlb_id, pitcher_name, pitcher_handedness
                FROM {lineup_src}
                WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL
                LIMIT 1
            """, (opponent, date))

        if not pitcher_row or not pitcher_row["pitcher_mlb_id"]:
            continue

        pitcher_id   = pitcher_row["pitcher_mlb_id"]
        pitcher_name = pitcher_row["pitcher_name"] or "Unknown SP"
        pitcher_hand = pitcher_row.get("pitcher_handedness") or "R"

        # -- Pitcher HR vulnerability -------------------------------------
        pitcher_hr_vuln = get_pitcher_hr_vulnerability(conn, pitcher_id, season)
        if not pitcher_hr_vuln:
            continue

        # -- Pitcher recent form (L5 / L15 starts) -------------------------
        p_rec15 = q1(conn, """
            SELECT era, home_runs, innings_pitched, strikeouts
            FROM pitcher_recent_stats
            WHERE mlb_id = ? AND window = 15
            ORDER BY season DESC LIMIT 1
        """, (pitcher_id,))
        p_rec5 = q1(conn, """
            SELECT era, home_runs, innings_pitched, strikeouts
            FROM pitcher_recent_stats
            WHERE mlb_id = ? AND window = 5
            ORDER BY season DESC LIMIT 1
        """, (pitcher_id,))

        pitcher_rec_era = None
        pitcher_rec_hr_rate = None  # HR per IP recent
        if p_rec15 and safe(p_rec15["innings_pitched"], 0) >= 5:
            pitcher_rec_era = safe(p_rec15["era"], None)
            ip15 = safe(p_rec15["innings_pitched"], 1)
            pitcher_rec_hr_rate = safe(p_rec15["home_runs"], 0) / max(ip15, 1)
        if p_rec5 and safe(p_rec5["innings_pitched"], 0) >= 3:
            # Blend: L5 (70%) + L15 (30%) for hot-streak sensitivity
            era5  = safe(p_rec5["era"], pitcher_rec_era or 4.20)
            era15 = pitcher_rec_era or era5
            pitcher_rec_era = era5 * 0.70 + era15 * 0.30
            ip5 = safe(p_rec5["innings_pitched"], 1)
            hr5_rate = safe(p_rec5["home_runs"], 0) / max(ip5, 1)
            pitcher_rec_hr_rate = (hr5_rate * 0.70
                                   + (pitcher_rec_hr_rate or hr5_rate) * 0.30)

        # -- Predict for each batter --------------------------------------
        for batter in lineup:
            try:
                bid = batter["mlb_id"]

                # ── Recent stats (last 20 games) ──────────────────────────────────────
                rs = q1(conn, """
                    SELECT iso, home_runs, at_bats
                    FROM hitter_recent_stats
                    WHERE mlb_id = ? AND window = 20
                    ORDER BY season DESC LIMIT 1
                """, (bid,))
                if rs and safe(rs["at_bats"], 0) >= 10:
                    recent_iso  = safe(rs["iso"],       0.15)
                    recent_hr_r = safe(rs["home_runs"], 0) / max(safe(rs["at_bats"], 1), 1)
                else:
                    recent_iso = recent_hr_r = 0.0

                # ── Hot-streak stats (last 5 games) ────────────────────────────────────
                rs5 = q1(conn, """
                    SELECT iso, home_runs, at_bats
                    FROM hitter_recent_stats
                    WHERE mlb_id = ? AND window = 5
                    ORDER BY season DESC LIMIT 1
                """, (bid,))
                if rs5 and safe(rs5["at_bats"], 0) >= 5:
                    l5_hr_r = safe(rs5["home_runs"], 0) / max(safe(rs5["at_bats"], 1), 1)
                else:
                    l5_hr_r = recent_hr_r

                # ── Season stats ──────────────────────────────────────────────────────
                ps = q1(conn, """
                    SELECT hr, games, avg, slg
                    FROM player_stats
                    WHERE mlb_id = ? AND season <= ?
                    ORDER BY season DESC LIMIT 1
                """, (bid, season))
                if ps and safe(ps["games"], 0) >= 5:
                    season_iso  = max(0.0, safe(ps["slg"], 0.40) - safe(ps["avg"], 0.25))
                    season_hr_r = safe(ps["hr"], 0) / max(safe(ps["games"], 1) * 3.8, 1)
                else:
                    season_iso  = recent_iso
                    season_hr_r = recent_hr_r

                # ── Barrel% from Statcast with PA-based shrinkage ─────────────────────
                # Barrel rate is stable for established hitters but noisy on small
                # samples (a prospect with 60 PA can have a misleading rate).
                # Shrink toward the 8% league average proportional to PA observed.
                # 400 PA ≈ a full season — full confidence. Current-season data with
                # 50-80 PA in April gets meaningful pull toward the mean.
                LG_BARREL_PCT = 8.0
                sh = (savant_hitter_map.get((bid, season))
                      or savant_hitter_map.get((bid, season - 1)))
                if sh:
                    barrel_pa     = safe(sh["pa"], 0)
                    barrel_shrink = min(1.0, barrel_pa / 400.0)
                    raw_barrel    = safe(sh["barrel_batted_rate"], LG_BARREL_PCT)
                    hitter_barrel = LG_BARREL_PCT + (raw_barrel - LG_BARREL_PCT) * barrel_shrink
                else:
                    hitter_barrel = max(0.0, 22.0 * season_iso - 0.4)

                # ── Career H2H vs this specific pitcher ───────────────────────────────
                h2h = h2h_career_map.get((bid, pitcher_id))
                h2h_hr_rate = (safe(h2h["hr"], 0) / max(safe(h2h["ab"], 1), 1)) if h2h else 0.0
                h2h_ab      = safe(h2h["ab"], 0) if h2h else 0.0

                # ── Constants (empirically derived from 2019-2024 DB analysis) ─────────
                # League avg HR/AB = 3.38%; using 3.3% as HR/PA proxy (PA includes walks)
                # Barrel→HR conversion: empirical ~0.40%/barrel% across the 7-22% range
                # Batting order factors: data shows 0.61x (9th) to 1.25x (2nd/3rd) spread
                # Handedness: L-batter hits more HRs regardless of pitcher hand (~1.18x vs 0.96x)
                # Pitcher HR rate: empirically only ±10% spread across tiers (weak signal)
                LG_HR_AB     = 0.0338   # empirical league HR/AB from 2019-2024
                LG_BARREL    = 8.0      # league avg barrel%
                BARREL_TO_HR = LG_HR_AB / (LG_BARREL / 100.0)  # 0.4225 empirical

                # ── Batting order factor (empirical from 2019-2024, blended 60% signal) ─
                # Raw: order 3 = 1.251x, order 9 = 0.610x. Blended to avoid double-counting
                # with barrel rate (power hitters bat high; barrel already captures quality).
                ORDER_RAW = {1:0.947, 2:1.250, 3:1.251, 4:1.180, 5:1.048,
                             6:0.896, 7:0.872, 8:0.750, 9:0.610}
                raw_order = ORDER_RAW.get(batter["batting_order"], 1.0)
                order_mult = 1.0 + (raw_order - 1.0) * 0.60

                # ── Handedness split (empirical: L-bat ~1.15x, R-bat ~1.00x on average) ─
                # Blended 50% — partly real platoon effect, partly park/lineup confound.
                HAND_RAW = {("L","L"):1.182, ("L","R"):1.118,
                            ("R","L"):0.963, ("R","R"):1.027}
                batter_hand = batter.get("handedness") or "R"
                raw_hand = HAND_RAW.get((batter_hand, pitcher_hand), 1.0)
                hand_mult = 1.0 + (raw_hand - 1.0) * 0.50

                # ── Batter base HR rate (barrel-anchored, Bayesian-shrunk) ────────────
                games_played = safe(ps["games"], 0) if ps and safe(ps["games"], 0) >= 5 else 0
                recent_ab    = safe(rs["at_bats"], 0) if rs and safe(rs["at_bats"], 0) >= 10 else 0
                l5_ab        = safe(rs5["at_bats"], 0) if rs5 and safe(rs5["at_bats"], 0) >= 5 else 0

                barrel_hr = max(0.003, min(0.10, hitter_barrel / 100.0 * BARREL_TO_HR))

                # Season HR/AB shrunk toward LG avg (need ~100 G for full confidence)
                s_shrink   = min(1.0, games_played / 100.0)
                season_adj = LG_HR_AB + (season_hr_r - LG_HR_AB) * s_shrink

                # L20 HR/AB shrunk toward LG avg (need ~60 AB for full confidence)
                r_shrink   = min(1.0, recent_ab / 60.0)
                recent_adj = LG_HR_AB + (recent_hr_r - LG_HR_AB) * r_shrink

                # L5 HR/AB — hot-streak signal, shrunk heavily (small sample)
                l5_shrink = min(1.0, l5_ab / 25.0)
                l5_adj    = LG_HR_AB + (l5_hr_r - LG_HR_AB) * l5_shrink

                # Weighted blend: barrel 35%, season 20%, L20 25%, L5 20%
                # Shifting weight from barrel toward recent form surfaces hot/cold batters.
                batter_hr_ab = (0.35 * barrel_hr
                                + 0.20 * season_adj
                                + 0.25 * recent_adj
                                + 0.20 * l5_adj)
                batter_hr_ab = max(0.003, min(0.09, batter_hr_ab))

                # ── Pitcher adjustment — career Savant base + recent ERA/HR correction ─
                pitcher_pa   = max(1, pitcher_hr_vuln.get("overall_pa", 1))
                p_shrink     = min(1.0, pitcher_pa / 200.0)
                p_hr_rate    = max(0.005, pitcher_hr_vuln["overall_hr_rate"])
                raw_excess   = (p_hr_rate / LG_HR_AB - 1.0) * p_shrink * 0.12
                pitcher_mult = max(0.88, min(1.12, 1.0 + raw_excess))

                # Layer recent pitcher form on top of career rate.
                # Recent HR/IP > lg avg (0.12) → pitcher giving up HRs right now.
                LG_HR_IP = 0.12
                if pitcher_rec_hr_rate is not None:
                    rec_excess = (pitcher_rec_hr_rate / LG_HR_IP - 1.0) * 0.10
                    pitcher_mult = max(0.85, min(1.18,
                                       pitcher_mult * 0.60 + (1.0 + rec_excess) * 0.40))
                # Recent ERA adds signal: ace on a current hot streak suppresses HRs more.
                if pitcher_rec_era is not None:
                    LG_ERA = 4.20
                    era_adj = (LG_ERA - pitcher_rec_era) * 0.015  # 1 ERA pt = ~1.5%
                    pitcher_mult = max(0.85, min(1.18, pitcher_mult + era_adj))

                # ── Park & weather (weather call here for batter-specific wind alignment) ─
                weather_factor, weather_info = get_weather_hr_factor(
                    conn, park_id, date, home_team, batter_hand=batter_hand)
                park_mult    = max(0.70, min(1.35, park_factor))
                weather_mult = max(0.88, min(1.14, weather_factor))

                # ── H2H — only meaningful at 30+ AB; small adjustment ─────────────────
                h2h_mult = 1.0
                if h2h_ab >= 30:
                    exp_rate = max(batter_hr_ab, 0.010)
                    h2h_mult = max(0.93, min(1.08,
                                   0.97 + (h2h_hr_rate / exp_rate) * 0.03))

                # ── Combined ──────────────────────────────────────────────────────────
                hr_prob_ab = (batter_hr_ab * pitcher_mult * order_mult * hand_mult
                              * park_mult * weather_mult * h2h_mult)
                hr_prob_ab = max(0.003, min(0.10, hr_prob_ab))

                # Per-game: empirical avg ~3.9 AB/game for starting lineup spots
                hr_per_game_prob = max(0.01, min(0.35, 1.0 - (1.0 - hr_prob_ab) ** 3.9))
                hr_prob_per_pa   = hr_prob_ab

                all_predictions.append({
                    "batter":           batter["name"],
                    "team":             team,
                    "vs_pitcher":       pitcher_name,
                    "opponent":         opponent,
                    "home_team":        home_team,
                    "park_id":          park_id or "?",
                    "hr_prob_per_pa":   hr_prob_per_pa * 100,
                    "hr_prob_per_game": hr_per_game_prob * 100,
                    "park_factor":      park_factor,
                    "weather_factor":   weather_factor,
                    "temp_f":           weather_info.get("temperature_f", "?"),
                    "wind_mph":         weather_info.get("wind_speed_raw_mph", "?"),
                    "weather_cond":     weather_info.get("weather_condition", ""),
                    "batting_order":    batter["batting_order"],
                })
            except Exception:
                continue

    conn.close()

    if not all_predictions:
        print("   No predictions generated.")
        return

    # Machine-readable JSON line for server parsing (must precede human-readable output)
    print("HRJSON:" + json.dumps(all_predictions))

    # Group by game, preserving insertion order (games processed in lineup order)
    games = {}
    for pred in all_predictions:
        away = pred["team"] if pred["team"] != pred["home_team"] else pred["opponent"]
        gkey = (pred["home_team"], away)
        if gkey not in games:
            games[gkey] = []
        games[gkey].append(pred)

    for (home, away), preds in games.items():
        # Game header info from any batter in this game
        sample   = preds[0]
        park     = sample["park_id"]
        temp_str = f"{sample['temp_f']:.0f}°F" if isinstance(sample["temp_f"], (int, float)) else "?°F"
        wind_str = f"{sample['wind_mph']:.0f}mph" if isinstance(sample["wind_mph"], (int, float)) else "?"
        cond     = sample.get("weather_cond", "") or ""
        park_f   = sample["park_factor"]

        header = f"  {away} @ {home}  |  {park}  |  park {park_f:.2f}  |  {temp_str}  {wind_str} wind  {cond}".rstrip()
        bar = "  " + "─" * (len(header) - 2)
        print(f"\n{bar}")
        print(header)
        print(bar)

        home_lineup = sorted([p for p in preds if p["team"] == home], key=lambda x: x["batting_order"])
        away_lineup = sorted([p for p in preds if p["team"] == away], key=lambda x: x["batting_order"])

        for team_label, lineup, sp_col in (
            (away, away_lineup, "vs_pitcher"),
            (home, home_lineup, "vs_pitcher"),
        ):
            if not lineup:
                continue
            sp_name = lineup[0][sp_col] if lineup else "?"
            print(f"\n  {team_label} lineup  (vs {sp_name})")
            print(f"  {'#':<3} {'BATTER':<22} {'HR%/GAME':>8}  {'HR%/PA':>6}  {'WTHR':>5}")
            print(f"  {'─'*3} {'─'*22} {'─'*8}  {'─'*6}  {'─'*5}")
            for p in lineup:
                wf = f"{p['weather_factor']:.2f}" if isinstance(p["weather_factor"], (int, float)) else "?"
                print(
                    f"  {p['batting_order']:<3} {p['batter']:<22} "
                    f"{p['hr_prob_per_game']:>7.1f}%  "
                    f"{p['hr_prob_per_pa']:>5.1f}%  "
                    f"{wf:>5}"
                )

    probs = [p["hr_prob_per_game"] for p in all_predictions]
    print(f"\n  {len(games)} game(s)  |  {len(all_predictions)} batters  |  "
          f"range {min(probs):.1f}%–{max(probs):.1f}%  |  median {sorted(probs)[len(probs)//2]:.1f}%")
    print()
def main():
    parser = argparse.ArgumentParser(description="Home Run Predictor")
    parser.add_argument("--train",   action="store_true", help="Train the model")
    parser.add_argument("--predict", action="store_true", help="Predict today's home runs")
    parser.add_argument("--date",    default=None, help="Override prediction date (YYYY-MM-DD)")
    args = parser.parse_args()
    
    if not args.train and not args.predict:
        print("Usage: python homerun_predictor.py --train --predict")
        return
    
    if args.train:
        df, feature_cols = build_hr_training_data()
        model, feature_cols, metrics = train_hr_model(df, feature_cols)

        with open(MODEL_PATH, "wb") as f:
            pickle.dump({"model": model, "feats": feature_cols}, f)

        with open(FEATURES_PATH, "w") as f:
            json.dump({
                "feature_cols": feature_cols,
                "trained_at": datetime.now().isoformat(),
                **metrics,
            }, f, indent=2)

        print(f"\n[OK] Model saved to {MODEL_PATH}")

    if args.predict:
        predict_today_homeruns(date_override=args.date)

if __name__ == "__main__":
    main()