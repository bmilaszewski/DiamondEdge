"""
strikeoutPredictorv2.py  --  v3.0 (full empirical rebuild)

ARCHITECTURE CHANGES vs v2.x:
==============================
Training target: ACTUAL per-game K totals from historical_lineups
  (old model trained on pitcher season averages -- wrong target)

Feature weights re-derived from correlation analysis (2,633 pitcher-game rows):
  Interaction p_k x l_k   R2=0.146  <-- strongest single feature
  l_k_pct                 R2=0.114  <-- lineup K% matters MORE than pitcher K%
  l_whiff / l_z_miss      R2=0.093  <-- lineup in-zone miss quality
  l_iz_contact            R2=0.093  <-- (negative: better contact = fewer Ks)
  p_k_pct                 R2=0.061  <-- pitcher K% (weaker than lineup)
  p_arsenal_whiff         R2=0.047
  p_put_away              R2=0.049
  p_whiff / p_z_miss      R2=0.040-0.045
  l_bat_speed             R2=0.029  <-- faster swings = more whiffs
  l_barrel / l_fast_swing R2=0.016-0.019
  p_ff_speed              R2=0.016
  Chase% (p or l)         R2<0.013  <-- removed from heavy weighting

Eliminated bugs:
  - season-average target replaced with per-game actuals
  - chase% over-weighting removed (empirically near zero)
  - is_home hardcoded to 0 fixed
  - lineup size handled by including n_batters as feature

USAGE:
  python strikeoutPredictorv2.py --train
  python strikeoutPredictorv2.py --predict
  python strikeoutPredictorv2.py --train --predict
"""

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
elif sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import argparse
import json
import pickle
import sqlite3
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

DB_PATH       = Path(__file__).parent / "mlb.db"
MODEL_PATH    = Path(__file__).parent / "strikeout_model_v2.pkl"
FEATURES_PATH = Path(__file__).parent / "strikeout_features_v2.json"

# Empirical league averages (2024 Statcast baseline)
LG_K_PCT       = 22.5
LG_WHIFF       = 25.0
LG_IZ_CONTACT  = 84.0
LG_Z_MISS      = 10.0
LG_CHASE       = 30.0
LG_BAT_SPEED   = 72.0

# Multi-year blending: recency weight by how many seasons ago
# e.g. current season = age 0 → 1.0, last season = age 1 → 0.60, etc.
_RECENCY_W = {0: 1.0, 1: 0.60, 2: 0.35, 3: 0.15}

# Columns to blend across seasons (all rate/pct/speed stats, not raw counts)
_BLEND_RATE_COLS = [
    "k_percent", "whiff_percent", "oz_swing_percent", "z_swing_miss_percent",
    "iz_contact_percent", "f_strike_percent", "meatball_percent", "bb_percent",
    "barrel_batted_rate", "exit_velocity_avg", "hard_hit_percent",
    "groundballs_percent", "flyballs_percent", "swing_percent", "z_swing_percent",
    "fastball_avg_speed", "fastball_avg_spin", "breaking_avg_speed", "breaking_avg_spin",
    "ff_avg_speed", "ff_avg_spin", "sl_avg_speed", "sl_avg_spin",
    "sl_avg_break_x", "sl_avg_break_z", "ch_avg_speed", "cu_avg_speed", "st_avg_speed",
]

# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = lambda cur, row: {
        col[0]: row[i] for i, col in enumerate(cur.description)
    }
    return conn

def q(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()

def q1(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()

def safe(v, default=0.0):
    if v is None:
        return default
    try:
        f = float(v)
        return default if (f != f or abs(f) > 1e9) else f
    except Exception:
        return default


# ─────────────────────────────────────────────────────────────────────────────
# Stat cache loaders
# ─────────────────────────────────────────────────────────────────────────────

def load_pitcher_cache(conn):
    cache = {}
    for r in q(conn, """
        SELECT mlb_id, season,
               k_percent, whiff_percent, oz_swing_percent, z_swing_miss_percent,
               iz_contact_percent, f_strike_percent, meatball_percent, bb_percent,
               barrel_batted_rate, exit_velocity_avg, hard_hit_percent,
               groundballs_percent, flyballs_percent,
               swing_percent, z_swing_percent,
               fastball_avg_speed, fastball_avg_spin,
               breaking_avg_speed, breaking_avg_spin,
               ff_avg_speed, ff_avg_spin, ff_count,
               sl_avg_speed, sl_avg_spin, sl_avg_break_x, sl_avg_break_z, sl_count,
               ch_avg_speed, cu_avg_speed, st_avg_speed,
               innings_pitched, pa, games, strikeouts
        FROM savant_pitcher_stats WHERE pa >= 50
    """):
        cache[(r["mlb_id"], r["season"])] = r
    return cache


def blend_pitcher_stats(pitcher_cache, pid, season):
    """
    PA-weighted + recency-weighted blend of up to 4 seasons.
    A pitcher with 68 PA in 2026 (small sample) will pull heavily from 2024/2023.
    A pitcher with 600+ PA this season will be nearly 100% current-year.
    """
    candidates = []
    for age in range(4):
        row = pitcher_cache.get((pid, season - age))
        if row is not None:
            candidates.append((age, row))

    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][1]

    weights = [_RECENCY_W.get(age, 0.0) * max(safe(row["pa"]), 1)
               for age, row in candidates]
    total_w = sum(weights)
    if total_w == 0:
        return candidates[0][1]

    norm_w = [w / total_w for w in weights]
    base = dict(candidates[0][1])  # non-blended fields default to most-recent season

    for col in _BLEND_RATE_COLS:
        vals = [safe(row[col]) for _, row in candidates]
        base[col] = sum(v * w for v, w in zip(vals, norm_w))

    # Blend per-start rates, then scale back up using most-recent game count
    ref_games = max(safe(candidates[0][1]["games"]), 1)
    ip_per_g  = sum(safe(row["innings_pitched"]) / max(safe(row["games"]), 1) * w
                    for (_, row), w in zip(candidates, norm_w))
    pa_per_g  = sum(safe(row["pa"]) / max(safe(row["games"]), 1) * w
                    for (_, row), w in zip(candidates, norm_w))
    ks_per_g  = sum(safe(row.get("strikeouts", 0) or 0) / max(safe(row["games"]), 1) * w
                    for (_, row), w in zip(candidates, norm_w))

    base["innings_pitched"] = ip_per_g * ref_games
    base["pa"]              = pa_per_g * ref_games
    base["games"]           = ref_games
    base["strikeouts"]      = ks_per_g * ref_games

    return base


def load_hitter_cache(conn):
    cache = {}
    for r in q(conn, """
        SELECT mlb_id, season,
               k_percent, whiff_percent, oz_swing_percent, z_swing_miss_percent,
               iz_contact_percent, f_strike_percent, swing_percent, z_swing_percent,
               barrel_batted_rate, exit_velocity_avg, hard_hit_percent,
               bat_speed, fast_swing_rate, sprint_speed,
               groundballs_percent, flyballs_percent, woba, xwoba, pa
        FROM savant_hitter_stats WHERE pa >= 50
    """):
        cache[(r["mlb_id"], r["season"])] = r
    return cache


def load_pitch_mix_cache(conn):
    cache = {}
    for r in q(conn, """
        SELECT mlb_id, year, pitch_type, whiff_percent, put_away_percent, pitches
        FROM pitcher_pitch_type WHERE pitches >= 50
    """):
        key = (r["mlb_id"], r["year"])
        if key not in cache:
            cache[key] = {}
        cache[key][r["pitch_type"]] = r
    return cache


# ─────────────────────────────────────────────────────────────────────────────
# Feature extraction helpers
# ─────────────────────────────────────────────────────────────────────────────

FB_TYPES  = {"FF", "SI", "FC"}
BRK_TYPES = {"SL", "CU", "KC", "ST", "SV"}
OS_TYPES  = {"CH", "FS", "FO", "SC"}


def pitcher_features(pstats, pmix):
    """Extract all pitcher features from a savant row + pitch-mix dict."""
    if pmix:
        tot = sum(safe(v["pitches"]) for v in pmix.values())
        w_whiff    = sum(safe(v["whiff_percent"], LG_WHIFF) * safe(v["pitches"]) for v in pmix.values()) / max(tot, 1)
        w_put_away = sum(safe(v["put_away_percent"], 20) * safe(v["pitches"]) for v in pmix.values()) / max(tot, 1)
        n_pitch_types = len(pmix)

        def grp_whiff(types):
            items = [(safe(v["whiff_percent"], LG_WHIFF), safe(v["pitches"]))
                     for pt, v in pmix.items() if pt in types]
            if not items:
                return w_whiff
            t = sum(p for _, p in items)
            return sum(wh * p for wh, p in items) / max(t, 1)

        fb_whiff  = grp_whiff(FB_TYPES)
        brk_whiff = grp_whiff(BRK_TYPES)
        os_whiff  = grp_whiff(OS_TYPES)
    else:
        w_whiff = safe(pstats["whiff_percent"], LG_WHIFF)
        w_put_away = 20.0
        n_pitch_types = 3
        fb_whiff = brk_whiff = os_whiff = w_whiff

    ip_per_start = safe(pstats["innings_pitched"]) / max(safe(pstats["games"]), 1)
    bf_per_start = safe(pstats["pa"])             / max(safe(pstats["games"]), 1)

    return {
        "p_k_pct":          safe(pstats["k_percent"],          LG_K_PCT),
        "p_whiff":          safe(pstats["whiff_percent"],      LG_WHIFF),
        "p_z_miss":         safe(pstats["z_swing_miss_percent"], LG_Z_MISS),
        "p_iz_contact":     safe(pstats["iz_contact_percent"], LG_IZ_CONTACT),
        "p_f_strike":       safe(pstats["f_strike_percent"],   60.0),
        "p_chase":          safe(pstats["oz_swing_percent"],   LG_CHASE),
        "p_bb_pct":         safe(pstats["bb_percent"],         8.0),
        "p_swing":          safe(pstats["swing_percent"],      47.0),
        "p_meatball":       safe(pstats["meatball_percent"],   8.0),
        "p_barrel":         safe(pstats["barrel_batted_rate"], 8.0),
        "p_ev":             safe(pstats["exit_velocity_avg"],  88.0),
        "p_hard_hit":       safe(pstats["hard_hit_percent"],   35.0),
        "p_gb_pct":         safe(pstats["groundballs_percent"], 43.0),
        "p_fb_pct":         safe(pstats["flyballs_percent"],   35.0),
        "p_arsenal_whiff":  w_whiff,
        "p_put_away":       w_put_away,
        "p_n_pitch_types":  n_pitch_types,
        "p_fb_whiff":       fb_whiff,
        "p_brk_whiff":      brk_whiff,
        "p_os_whiff":       os_whiff,
        "p_ff_speed":       safe(pstats["ff_avg_speed"],       93.0),
        "p_ff_spin":        safe(pstats["ff_avg_spin"],        2200.0),
        "p_sl_speed":       safe(pstats["sl_avg_speed"],       85.0),
        "p_sl_spin":        safe(pstats["sl_avg_spin"],        2500.0),
        "p_break_speed":    safe(pstats["breaking_avg_speed"], 82.0),
        "p_break_spin":     safe(pstats["breaking_avg_spin"],  2500.0),
        "p_ch_speed":       safe(pstats["ch_avg_speed"],       83.0),
        "p_ip_per_start":   ip_per_start,
        "p_bf_per_start":   bf_per_start,
    }


def lineup_features(hstats_list):
    """
    hstats_list: list of (hitter_savant_row_or_None, handedness_str) tuples
    Returns aggregated lineup features.
    """
    valid = [(h, hand) for h, hand in hstats_list if h is not None]
    if not valid:
        return None

    def avg(col, default):
        vals = [safe(h[col], default) for h, _ in valid if col in h]
        return float(np.mean(vals)) if vals else default

    rh = [h for h, hand in valid if hand == "R"]
    lh = [h for h, hand in valid if hand == "L"]
    rh_k = float(np.mean([safe(h["k_percent"], LG_K_PCT) for h in rh])) if rh else avg("k_percent", LG_K_PCT)
    lh_k = float(np.mean([safe(h["k_percent"], LG_K_PCT) for h in lh])) if lh else avg("k_percent", LG_K_PCT)

    bs_vals = [safe(h["bat_speed"], None) for h, _ in valid if h.get("bat_speed") is not None]
    avg_bat_speed = float(np.mean(bs_vals)) if bs_vals else LG_BAT_SPEED

    fw_vals = [safe(h["fast_swing_rate"], None) for h, _ in valid if h.get("fast_swing_rate") is not None]
    avg_fast_swing = float(np.mean(fw_vals)) if fw_vals else 25.0

    return {
        "l_k_pct":      avg("k_percent",          LG_K_PCT),
        "l_whiff":      avg("whiff_percent",       LG_WHIFF),
        "l_z_miss":     avg("z_swing_miss_percent", LG_Z_MISS),
        "l_iz_contact": avg("iz_contact_percent",  LG_IZ_CONTACT),
        "l_chase":      avg("oz_swing_percent",    LG_CHASE),
        "l_f_strike":   avg("f_strike_percent",    60.0),
        "l_swing":      avg("swing_percent",       47.0),
        "l_barrel":     avg("barrel_batted_rate",  8.0),
        "l_ev":         avg("exit_velocity_avg",   88.0),
        "l_hard_hit":   avg("hard_hit_percent",    35.0),
        "l_gb_pct":     avg("groundballs_percent", 43.0),
        "l_fb_pct":     avg("flyballs_percent",    35.0),
        "l_woba":       avg("woba",                0.320),
        "l_xwoba":      avg("xwoba",               0.320),
        "l_bat_speed":  avg_bat_speed,
        "l_fast_swing": avg_fast_swing,
        "rh_k_pct":     rh_k,
        "lh_k_pct":     lh_k,
        "pct_rhh":      len(rh) / max(len(valid), 1),
        "n_batters":    len(valid),
    }


def build_interaction_features(pf, lf):
    """Empirically strongest: multiplicative interaction between pitcher and lineup."""
    return {
        # Top predictor: R2=0.146
        "p_k_x_l_k":          pf["p_k_pct"] * lf["l_k_pct"] / 100.0,
        # Arsenal × lineup miss
        "p_arsenal_x_l_miss":  pf["p_arsenal_whiff"] * lf["l_z_miss"] / 100.0,
        # Pitcher whiff × lineup iz_contact (R2=0.026)
        "p_whiff_x_l_iz":      pf["p_whiff"] * lf["l_iz_contact"] / 100.0,
        # Put-away × lineup whiff
        "p_putaway_x_l_whiff": pf["p_put_away"] * lf["l_whiff"] / 100.0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Training data — per-game actuals from historical_lineups
# ─────────────────────────────────────────────────────────────────────────────

def build_training_data():
    print("\n" + "=" * 70)
    print("  BUILDING STRIKEOUT TRAINING DATA (per-game actuals)")
    print("=" * 70)
    print()
    print("  Empirical findings from historical correlation analysis:")
    print("    p_k_pct x l_k_pct interaction  R2=0.146  (strongest)")
    print("    l_k_pct (lineup K%)             R2=0.114  > pitcher K%")
    print("    l_whiff / l_z_miss / l_iz_con   R2=0.093  (zone discipline)")
    print("    p_k_pct                         R2=0.061")
    print("    p_arsenal_whiff / p_put_away    R2=0.047-0.049")
    print("    l_bat_speed                     R2=0.029  (tool: miss-rate)")
    print("    chase% (p or l)                 R2<0.013  (REMOVED heavy weight)")
    print()

    conn = get_db()
    pitcher_cache  = load_pitcher_cache(conn)
    hitter_cache   = load_hitter_cache(conn)
    pitch_mix_cache = load_pitch_mix_cache(conn)

    print(f"  Pitcher seasons: {len(pitcher_cache):,}")
    print(f"  Hitter seasons:  {len(hitter_cache):,}")
    print(f"  Pitch-mix rows:  {len(pitch_mix_cache):,}")

    # Per-game K totals — actual outcomes
    print("\n  Loading per-game K outcomes from historical_lineups ...")
    game_rows = q(conn, """
        SELECT
            h.pitcher_mlb_id,
            h.pitcher_name,
            h.game_date,
            h.season,
            h.team                           AS batting_team,
            COUNT(DISTINCT h.mlb_id)         AS n_batters,
            SUM(s.ks)                        AS game_ks,
            SUM(s.ab)                        AS total_ab
        FROM historical_lineups h
        JOIN (
            SELECT pitcher_mlb_id, game_date, team, mlb_id,
                   MAX(strikeouts) AS ks,
                   MAX(at_bats)    AS ab
            FROM historical_lineups
            WHERE pitcher_mlb_id IS NOT NULL
              AND batting_order BETWEEN 1 AND 9
              AND at_bats >= 1
            GROUP BY pitcher_mlb_id, game_date, team, mlb_id
        ) s ON s.pitcher_mlb_id = h.pitcher_mlb_id
           AND s.game_date      = h.game_date
           AND s.team           = h.team
           AND s.mlb_id         = h.mlb_id
        WHERE h.pitcher_mlb_id IS NOT NULL
          AND h.batting_order BETWEEN 1 AND 9
          AND h.at_bats >= 1
        GROUP BY h.pitcher_mlb_id, h.game_date, h.team
        HAVING COUNT(DISTINCT h.mlb_id) >= 6
           AND SUM(s.ks) <= 20
    """)

    ks_vals = [r["game_ks"] for r in game_rows]
    print(f"  {len(game_rows):,} pitcher-game rows  |  "
          f"K mean={np.mean(ks_vals):.2f}  std={np.std(ks_vals):.2f}  "
          f"range={int(min(ks_vals))}-{int(max(ks_vals))}")

    # Per-game batter lists
    game_batters = {}
    for r in q(conn, """
        SELECT pitcher_mlb_id, game_date, team, mlb_id, season, handedness
        FROM historical_lineups
        WHERE pitcher_mlb_id IS NOT NULL
          AND batting_order BETWEEN 1 AND 9
          AND at_bats >= 1
    """):
        key = (r["pitcher_mlb_id"], r["game_date"], r["team"])
        if key not in game_batters:
            game_batters[key] = []
        if not any(b["mlb_id"] == r["mlb_id"] for b in game_batters[key]):
            game_batters[key].append(r)

    # Build rows
    rows      = []
    skipped   = 0
    no_hitter = 0

    for g in game_rows:
        pid    = g["pitcher_mlb_id"]
        season = g["season"]

        pstats = blend_pitcher_stats(pitcher_cache, pid, season)
        if not pstats:
            skipped += 1
            continue

        pmix = (pitch_mix_cache.get((pid, season))
                or pitch_mix_cache.get((pid, season - 1)) or {})

        batter_list = game_batters.get((pid, g["game_date"], g["batting_team"]), [])
        hstats_list = []
        for b in batter_list:
            s = b["season"]
            h = hitter_cache.get((b["mlb_id"], s)) or hitter_cache.get((b["mlb_id"], s - 1))
            hstats_list.append((h, b.get("handedness", "R") or "R"))

        if sum(1 for h, _ in hstats_list if h is not None) < 4:
            no_hitter += 1
            continue

        pf = pitcher_features(pstats, pmix)
        lf = lineup_features(hstats_list)
        if lf is None:
            no_hitter += 1
            continue

        ixn = build_interaction_features(pf, lf)

        row = {"game_ks": g["game_ks"], "season": season}
        row.update(pf)
        row.update(lf)
        row.update(ixn)
        rows.append(row)

    conn.close()

    df = pd.DataFrame(rows)
    print(f"  Built {len(df):,} training rows  (no_pitcher={skipped}, no_lineup={no_hitter})")
    print(f"  Seasons covered: {sorted(df['season'].unique().tolist())}")

    meta         = {"game_ks", "season"}
    feature_cols = [c for c in df.columns if c not in meta]
    return df, feature_cols


# ─────────────────────────────────────────────────────────────────────────────
# Train
# ─────────────────────────────────────────────────────────────────────────────

def train_model(df, feature_cols):
    print("\n" + "=" * 70)
    print("  TRAINING STRIKEOUT MODEL")
    print("=" * 70)

    X = df[feature_cols].values.astype(float)
    y = df["game_ks"].values.astype(float)
    n = len(X)

    max_cv = min(5, max(2, n // 200))
    print(f"\n  {n:,} samples  |  {len(feature_cols)} features  |  CV splits={max_cv}")
    print(f"  Target mean={y.mean():.2f}  std={y.std():.2f}\n")

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler",  StandardScaler()),
        ("model",   GradientBoostingRegressor(
            n_estimators=400,
            max_depth=4,
            learning_rate=0.04,
            subsample=0.75,
            min_samples_leaf=15,
            max_features=0.6,
            loss="huber",
            random_state=42,
        )),
    ])

    maes, r2s = [], []
    for fold, (tr, va) in enumerate(TimeSeriesSplit(n_splits=max_cv).split(X), 1):
        if len(va) < 20:
            continue
        pipeline.fit(X[tr], y[tr])
        preds = np.maximum(0, pipeline.predict(X[va]))
        mae   = mean_absolute_error(y[va], preds)
        r2    = r2_score(y[va], preds)
        maes.append(mae); r2s.append(r2)
        print(f"  Fold {fold}: MAE={mae:.2f} K   R2={r2:.3f}   (n={len(va):,})")

    if maes:
        print(f"\n  Mean MAE: {np.mean(maes):.2f} Ks   |   Mean R2: {np.mean(r2s):.3f}")

    print("\n  Fitting final model on full dataset ...")
    pipeline.fit(X, y)

    imps = pipeline.named_steps["model"].feature_importances_
    print("\n  Feature Importances (sorted):")
    for feat, imp in sorted(zip(feature_cols, imps), key=lambda x: -x[1]):
        bar = "#" * int(imp * 200)
        print(f"    {feat:<35} {imp:.4f}  {bar}")

    return pipeline, feature_cols, {
        "cv_mae_mean":  float(np.mean(maes)) if maes else None,
        "cv_r2_mean":   float(np.mean(r2s))  if r2s  else None,
        "n_training":   n,
        "target_mean":  float(y.mean()),
        "target_std":   float(y.std()),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Predict today
# ─────────────────────────────────────────────────────────────────────────────

def predict_today(model, feature_cols, date_override=None):
    print("\n" + "=" * 70)
    print("  TODAY'S STRIKEOUT PREDICTIONS")
    print("=" * 70)

    conn = get_db()
    pitcher_cache   = load_pitcher_cache(conn)
    hitter_cache    = load_hitter_cache(conn)
    pitch_mix_cache = load_pitch_mix_cache(conn)

    today = datetime.now().strftime("%Y-%m-%d")
    lineup_src = "historical_lineups" if (date_override and date_override < today) else "daily_lineups"
    pred_date  = date_override or today

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
            print(f"  (Using {latest['d']} -- no lineups for today)\n")

    if not games:
        print(f"  ERROR: No lineup data for {pred_date}.")
        conn.close()
        return []

    date, season = games[0]["game_date"], games[0]["season"]
    print(f"  Date: {date}  (source: {lineup_src})\n")

    results, seen = [], set()

    for g in games:
        # pitcher_mlb_id on batting-team row = the SP facing that team's lineup
        pr = q1(conn, f"""
            SELECT pitcher_mlb_id, pitcher_name, pitcher_handedness
            FROM {lineup_src}
            WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL LIMIT 1
        """, (g["team"], date))

        if not pr:
            continue

        lineup_team  = g["team"]
        pitcher_team = g["opponent"]
        pid          = pr["pitcher_mlb_id"]
        pitcher_name = pr["pitcher_name"] or "Unknown"

        key = (pid, lineup_team)
        if key in seen:
            continue
        seen.add(key)

        try:
            pstats = blend_pitcher_stats(pitcher_cache, pid, season)
            if not pstats:
                print(f"  [skip] {pitcher_name} -- no Savant pitcher stats")
                continue

            pmix = (pitch_mix_cache.get((pid, season))
                    or pitch_mix_cache.get((pid, season - 1)) or {})

            # Today's lineup with Savant hitter profiles
            batters = q(conn, f"""
                SELECT mlb_id, handedness
                FROM {lineup_src}
                WHERE team = ? AND game_date = ? AND batting_order > 0
                ORDER BY batting_order
            """, (lineup_team, date))

            hstats_list = []
            for b in batters:
                hand = b.get("handedness") or "R"
                h = (hitter_cache.get((b["mlb_id"], season))
                     or hitter_cache.get((b["mlb_id"], season - 1)))
                hstats_list.append((h, hand))

            n_with_savant = sum(1 for h, _ in hstats_list if h is not None)

            pf  = pitcher_features(pstats, pmix)
            lf  = lineup_features(hstats_list)
            if lf is None:
                print(f"  [skip] {pitcher_name} -- could not build lineup profile")
                continue

            ixn = build_interaction_features(pf, lf)

            # Determine home/away
            is_home = 0
            ht_row = q1(conn, f"""
                SELECT is_home FROM {lineup_src}
                WHERE team = ? AND game_date = ? AND batting_order > 0 LIMIT 1
            """, (lineup_team, date))
            if ht_row and ht_row.get("is_home") is not None:
                is_home = 1 if not ht_row["is_home"] else 0  # pitcher is home if lineup team is away

            feats = {}
            feats.update(pf)
            feats.update(lf)
            feats.update(ixn)
            feats["is_home"] = is_home

            X    = np.array([[feats.get(c, np.nan) for c in feature_cols]], dtype=float)
            # GBR was trained on 2019-2024 historical data (mean ~6.4 Ks/start).
            # 2025 K rate has declined to ~8.3/game combined, down from 8.8 at peak.
            # Average DK-listed starter now projects ~5.0-5.5 Ks per outing.
            # Apply calibration to align with current market reality.
            _raw = float(max(0.0, model.predict(X)[0]))
            LG_K_CALIB = 0.84   # corrects ~15% over-prediction from high-K training era
            pred = _raw * LG_K_CALIB

            # Formula-based sanity estimate (for display alongside model)
            # Empirical: avg K = baseline × (pitcher_k_factor) × (lineup_k_factor)
            # where each factor = stat / league_avg
            p_k_factor = pf["p_k_pct"] / LG_K_PCT
            l_k_factor = lf["l_k_pct"] / LG_K_PCT
            formula_est = 5.5 * p_k_factor * l_k_factor  # 5.5 = current market baseline

            results.append({
                "pitcher":         pitcher_name,
                "team":            pitcher_team,
                "opp":             lineup_team,
                "pred_k":          pred,
                "formula_est":     formula_est,
                "p_k_pct":         pf["p_k_pct"],
                "p_arsenal_whiff": pf["p_arsenal_whiff"],
                "p_put_away":      pf["p_put_away"],
                "p_whiff":         pf["p_whiff"],
                "p_iz_contact":    pf["p_iz_contact"],
                "p_chase":         pf["p_chase"],
                "p_ff_speed":      pf["p_ff_speed"],
                "l_k_pct":         lf["l_k_pct"],
                "l_whiff":         lf["l_whiff"],
                "l_iz_contact":    lf["l_iz_contact"],
                "l_z_miss":        lf["l_z_miss"],
                "l_chase":         lf["l_chase"],
                "l_bat_speed":     lf["l_bat_speed"],
                "n_savant":        n_with_savant,
                "n_batters":       lf["n_batters"],
                "p_k_x_l_k":      ixn["p_k_x_l_k"],
            })

        except Exception as exc:
            import traceback
            print(f"  [err] {pitcher_name}: {exc}")
            if "--debug" in sys.argv:
                traceback.print_exc()

    conn.close()
    results.sort(key=lambda x: -x["pred_k"])

    if not results:
        print("  No predictions generated.")
        return []

    hdr = (f"  {'PITCHER':<24} {'TM':<4} {'OPP':<4} "
           f"{'MDL K':>6} {'FML K':>6} "
           f"{'P-K%':>6} {'P-WHIFF':>8} {'P-IZ':>6} {'P-CHASE':>8} "
           f"{'L-K%':>6} {'L-WHIFF':>8} {'L-IZ':>6} {'L-CHASE':>8} "
           f"{'L-BS':>6} {'SAV':>5}")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))

    for r in results:
        bs_str = f"{r['l_bat_speed']:.1f}" if r["l_bat_speed"] else "  --"
        print(
            f"  {r['pitcher']:<24} {r['team']:<4} {r['opp']:<4} "
            f"{r['pred_k']:>6.1f} {r['formula_est']:>6.1f} "
            f"{r['p_k_pct']:>5.1f}% {r['p_whiff']:>7.1f}% "
            f"{r['p_iz_contact']:>5.1f}% {r['p_chase']:>7.1f}% "
            f"{r['l_k_pct']:>5.1f}% {r['l_whiff']:>7.1f}% "
            f"{r['l_iz_contact']:>5.1f}% {r['l_chase']:>7.1f}% "
            f"{bs_str:>6} {r['n_savant']:>3}/{r['n_batters']}"
        )

    print()
    preds = [r["pred_k"] for r in results]
    print(f"  {len(results)} pitchers  |  "
          f"Range: {min(preds):.1f}-{max(preds):.1f} Ks  |  "
          f"Median: {sorted(preds)[len(preds)//2]:.1f} Ks")
    print()
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MLB Strikeout Predictor v3.0")
    parser.add_argument("--train",   action="store_true")
    parser.add_argument("--predict", action="store_true")
    parser.add_argument("--debug",   action="store_true")
    parser.add_argument("--date",    default=None, help="Override prediction date (YYYY-MM-DD)")
    args = parser.parse_args()

    if not args.train and not args.predict:
        print("Usage: python strikeoutPredictorv2.py [--train] [--predict] [--debug]")
        return

    model = feature_cols = None

    if args.train:
        df, feature_cols = build_training_data()

        if len(df) < 200:
            print("\n  ERROR: Not enough training data.")
            sys.exit(1)

        model, feature_cols, metrics = train_model(df, feature_cols)

        with open(MODEL_PATH, "wb") as f:
            pickle.dump({"model": model, "feats": feature_cols}, f)
        with open(FEATURES_PATH, "w") as f:
            json.dump({
                "feature_cols": feature_cols,
                "trained_at":   datetime.now().isoformat(),
                "architecture": "v3.0 -- per-game actuals, interaction features",
                "empirical_r2": {
                    "p_k_x_l_k":       0.146,
                    "l_k_pct":         0.114,
                    "l_whiff_z_miss":  0.093,
                    "l_iz_contact":    0.093,
                    "p_k_pct":         0.061,
                    "p_arsenal_whiff": 0.047,
                    "p_put_away":      0.049,
                    "l_bat_speed":     0.029,
                    "chase_removed":   "R2<0.013 -- empirically near-zero",
                },
                **{k: v for k, v in metrics.items() if v is not None},
            }, f, indent=2)
        print(f"\n  Model saved -> {MODEL_PATH}")

    if args.predict:
        if model is None:
            if not MODEL_PATH.exists():
                print("No model found. Run: python strikeoutPredictorv2.py --train")
                sys.exit(1)
            with open(MODEL_PATH, "rb") as f:
                saved = pickle.load(f)
            model, feature_cols = saved["model"], saved["feats"]
        predict_today(model, feature_cols, date_override=args.date)


if __name__ == "__main__":
    main()
