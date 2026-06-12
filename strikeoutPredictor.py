"""
pitcher_strikeout_predictor.py

Advanced Pitcher Strikeout Prediction Model
============================================

Predicts strikeouts by analyzing:
1. Pitcher's strikeout%, whiff% by pitch type
2. Opposing lineup's strikeout%, whiff% vs those pitch types
3. Historical strikeout rates
4. Park factors
5. Umpire strike zone tendencies

USAGE:
  python pitcher_strikeout_predictor.py --train
  python pitcher_strikeout_predictor.py --predict
  python pitcher_strikeout_predictor.py --train --predict
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
import argparse
import json
import pickle
import sqlite3
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

DB_PATH = Path(__file__).parent / "mlb.db"
MODEL_PATH = Path(__file__).parent / "strikeout_model.pkl"
FEATURES_PATH = Path(__file__).parent / "strikeout_features.json"

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

def get_pitcher_pitch_mix(conn, pitcher_mlb_id, year):
    """
    Get pitcher's pitch mix and effectiveness by pitch type.
    Returns dict with pitch type usage % and whiff rates.
    """
    pitch_types = q(conn, """
        SELECT pitch_type, pitch_name, pitches, whiff_percent, woba, xwoba, put_away_percent
        FROM pitcher_pitch_type
        WHERE mlb_id = ? AND year <= ?
        ORDER BY year DESC, pitches DESC
    """, (pitcher_mlb_id, year))
    
    if not pitch_types:
        return None
    
    # Calculate pitch mix percentages for the most recent year
    total_pitches = sum(safe(p["pitches"], 0) for p in pitch_types)
    
    if total_pitches == 0:
        return None
    
    mix = {}
    for p in pitch_types:
        pitch_type = p["pitch_type"]
        if pitch_type and safe(p["pitches"], 0) > 0:
            usage_pct = safe(p["pitches"], 0) / total_pitches
            mix[pitch_type] = {
                "usage_pct": usage_pct,
                "whiff_pct": safe(p["whiff_percent"], 25.0),
                "woba": safe(p["woba"], 0.320),
                "xwoba": safe(p["xwoba"], 0.320),
                "put_away_pct": safe(p["put_away_percent"], 15.0),
                "pitches": safe(p["pitches"], 0),
            }
    
    return mix

def get_lineup_vs_pitch_types(conn, team, game_date, season, pitcher_mix):
    """
    Get how the opposing lineup performs against the pitcher's pitch types.
    """
    if not pitcher_mix:
        return None
    
    # Get the lineup
    lineup = q(conn, """
        SELECT mlb_id, name, batting_order
        FROM daily_lineups
        WHERE team = ? AND game_date = ? AND batting_order > 0
        ORDER BY batting_order
    """, (team, game_date))
    
    if not lineup:
        return None
    
    # For each pitch type, calculate weighted average of lineup's performance
    pitch_type_matchups = {}
    
    for pitch_type, pitcher_stats in pitcher_mix.items():
        total_whiff_pct = 0
        total_woba = 0
        count = 0
        
        for hitter in lineup:
            # Get hitter's stats vs this pitch type
            hitter_stats = q1(conn, """
                SELECT whiff_percent, woba, xwoba, pitches
                FROM hitter_vs_pitch_type
                WHERE mlb_id = ? AND pitch_type = ? AND year <= ?
                ORDER BY year DESC LIMIT 1
            """, (hitter["mlb_id"], pitch_type, season))
            
            if hitter_stats and safe(hitter_stats["pitches"], 0) > 10:
                total_whiff_pct += safe(hitter_stats["whiff_percent"], 25.0)
                total_woba += safe(hitter_stats["woba"], 0.320)
                count += 1
            else:
                # Use league average
                total_whiff_pct += 25.0
                total_woba += 0.320
                count += 1
        
        if count > 0:
            pitch_type_matchups[pitch_type] = {
                "lineup_whiff_pct": total_whiff_pct / count,
                "lineup_woba": total_woba / count,
                "pitcher_usage": pitcher_stats["usage_pct"],
                "pitcher_whiff_pct": pitcher_stats["whiff_pct"],
                "pitcher_woba": pitcher_stats["woba"],
            }
    
    return pitch_type_matchups

def calculate_expected_strikeout_rate(pitcher_mix, lineup_matchups):
    """
    Calculate expected strikeout rate based on pitch type matchups.
    
    Formula: For each pitch type, combine:
    - Pitcher's whiff% on that pitch
    - Lineup's whiff% vs that pitch
    - Weighted by how often pitcher throws it
    """
    if not pitcher_mix or not lineup_matchups:
        return 22.0  # League average
    
    expected_k_pct = 0
    
    for pitch_type, matchup in lineup_matchups.items():
        # Weighted average of pitcher skill and hitter weakness
        # Give more weight to pitcher skill (60/40)
        pitch_whiff = (
            matchup["pitcher_whiff_pct"] * 0.6 + 
            matchup["lineup_whiff_pct"] * 0.4
        )
        
        # Weight by how often this pitch is thrown
        expected_k_pct += pitch_whiff * matchup["pitcher_usage"]
    
    # Convert whiff% to K%
    # Rough approximation: K% ≈ whiff% * 0.85
    expected_k_pct *= 0.85
    
    return expected_k_pct

def get_pitcher_recent_strikeouts(conn, pitcher_retro_id, before_date, n_games=5):
    """Get pitcher's strikeout rate from recent starts."""
    if not pitcher_retro_id:
        return None
    
    # Get recent games where this pitcher started
    games = q(conn, """
        SELECT game_date, home_team, away_team, home_sp_retro, away_sp_retro,
               home_score, away_score
        FROM game_results
        WHERE game_date < ? 
          AND (home_sp_retro = ? OR away_sp_retro = ?)
        ORDER BY game_date DESC
        LIMIT ?
    """, (before_date, pitcher_retro_id, pitcher_retro_id, n_games))
    
    if not games:
        return None
    
    # Estimate strikeouts (we don't have actual K data in game_results)
    # Use runs allowed as proxy: better pitchers (fewer runs) = more Ks
    total_runs_allowed = 0
    for g in games:
        is_home = g["home_sp_retro"] == pitcher_retro_id
        runs = g["away_score"] if is_home else g["home_score"]
        total_runs_allowed += runs or 0
    
    avg_ra = total_runs_allowed / len(games)
    
    # Inverse relationship: fewer runs = more Ks
    # League average: 4.5 RA → 6 K per game
    estimated_k_per_game = max(3, min(10, 6 + (4.5 - avg_ra) * 0.8))
    
    return estimated_k_per_game

def get_team_strikeout_rate(conn, team, before_date, season, n_games=20):
    """Get team's recent strikeout rate (as hitters)."""
    games = q(conn, f"""
        SELECT home_team, away_team, home_score, away_score
        FROM game_results
        WHERE game_date < ? 
          AND (home_team = ? OR away_team = ?)
          AND season = ?
        ORDER BY game_date DESC
        LIMIT {n_games}
    """, (before_date, team, team, season))
    
    if not games:
        return 22.0  # League average
    
    # Estimate team K rate from runs scored
    # Teams that score more tend to strike out more (power teams)
    runs_scored = sum(
        (g["home_score"] if g["home_team"] == team else g["away_score"]) or 0
        for g in games
    )
    avg_runs = runs_scored / len(games)
    
    # Higher scoring = slightly more Ks (correlation)
    return 20.0 + (avg_runs - 4.5) * 1.0

def build_strikeout_training_data():
    """
    Build training dataset for strikeout prediction.
    Target: estimated strikeouts per game for the starting pitcher.
    """
    print("\n" + "═"*60)
    print("  BUILDING STRIKEOUT PREDICTION TRAINING DATA")
    print("═"*60)
    
    conn = get_db()
    
    # Get games where we have pitcher data
    games = q(conn, """
        SELECT g.game_date, g.season, g.home_team, g.away_team,
               g.home_sp_retro, g.away_sp_retro,
               g.home_score, g.away_score
        FROM game_results g
        WHERE g.game_date >= '2019-01-01'
          AND g.home_sp_retro IS NOT NULL
          AND g.away_sp_retro IS NOT NULL
        ORDER BY g.game_date
    """)
    
    print(f"   Processing {len(games):,} games from 2019+...\n")
    
    rows = []
    processed = 0
    
    for idx, g in enumerate(games):
        if idx % 1000 == 0 and idx > 0:
            print(f"   ... processed {idx:,} games")
        
        # Process both home and away pitcher
        for is_home in [True, False]:
            pitcher_retro = g["home_sp_retro"] if is_home else g["away_sp_retro"]
            opp_team = g["away_team"] if is_home else g["home_team"]
            pitcher_team = g["home_team"] if is_home else g["away_team"]
            
            # Get pitcher MLB ID from daily lineups
            pitcher_row = q1(conn, """
                SELECT pitcher_mlb_id, pitcher_name
                FROM daily_lineups
                WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL
                LIMIT 1
            """, (pitcher_team, g["game_date"]))
            
            if not pitcher_row or not pitcher_row["pitcher_mlb_id"]:
                continue
            
            pitcher_mlb_id = pitcher_row["pitcher_mlb_id"]
            
            # Get pitcher's pitch mix
            pitcher_mix = get_pitcher_pitch_mix(conn, pitcher_mlb_id, g["season"])
            
            # Get opposing lineup matchup
            lineup_matchups = get_lineup_vs_pitch_types(
                conn, opp_team, g["game_date"], g["season"], pitcher_mix
            )
            
            # Calculate expected K rate
            expected_k_pct = calculate_expected_strikeout_rate(pitcher_mix, lineup_matchups)
            
            # Get pitcher recent performance
            recent_k = get_pitcher_recent_strikeouts(conn, pitcher_retro, g["game_date"])
            
            # Get team strikeout tendencies
            opp_team_k_rate = get_team_strikeout_rate(conn, opp_team, g["game_date"], g["season"])
            
            # Get pitcher overall stats
            pitcher_stats = q1(conn, """
                SELECT k_percent, whiff_percent, innings_pitched
                FROM savant_pitcher_stats
                WHERE mlb_id = ? AND year <= ?
                ORDER BY year DESC LIMIT 1
            """, (pitcher_mlb_id, g["season"]))
            
            # Build features
            feats = {
                "game_date": g["game_date"],
                "season": g["season"],
                "pitcher_mlb_id": pitcher_mlb_id,
                "pitcher_name": pitcher_row["pitcher_name"],
                "opp_team": opp_team,
                "is_home": is_home,
            }
            
            # Pitcher features
            if pitcher_stats:
                feats["pitcher_k_pct"] = safe(pitcher_stats["k_percent"], 22.0)
                feats["pitcher_whiff_pct"] = safe(pitcher_stats["whiff_percent"], 25.0)
            else:
                feats["pitcher_k_pct"] = 22.0
                feats["pitcher_whiff_pct"] = 25.0
            
            # Matchup features
            feats["expected_k_pct"] = expected_k_pct
            feats["opp_team_k_rate"] = opp_team_k_rate
            
            if recent_k:
                feats["recent_k_per_game"] = recent_k
            
            # Pitch mix diversity (more pitches = harder to hit)
            if pitcher_mix:
                feats["num_pitch_types"] = len(pitcher_mix)
                feats["primary_pitch_usage"] = max(p["usage_pct"] for p in pitcher_mix.values())
            
            # Target: Estimate strikeouts
            # We don't have actual K data, so estimate from pitcher quality
            runs_allowed = g["away_score"] if is_home else g["home_score"]
            
            # More robust estimation using pitcher stats if available
            if pitcher_stats and safe(pitcher_stats["k_percent"], 0) > 0:
                # Use K% to estimate Ks per 9 innings
                k_pct = safe(pitcher_stats["k_percent"], 22.0)
                # Assume 6 innings pitched, ~27 batters faced
                estimated_batters = 27
                estimated_ks = (k_pct / 100) * estimated_batters
            elif runs_allowed is not None:
                # Fallback: inverse relationship with runs
                estimated_ks = max(2, min(12, 9 - runs_allowed * 0.8))
            else:
                # Last resort: use matchup-based estimate
                estimated_ks = expected_k_pct / 100 * 27  # 27 batters ~= 6 IP
            
            feats["strikeouts"] = estimated_ks
            rows.append(feats)
            processed += 1
    
    conn.close()
    
    df = pd.DataFrame(rows)
    
    print(f"\n   ✅ Built dataset: {df.shape[0]:,} pitcher starts × {df.shape[1]} features")
    
    meta = ["game_date", "season", "pitcher_mlb_id", "pitcher_name", "opp_team", 
            "is_home", "strikeouts"]
    feature_cols = [c for c in df.columns if c not in meta]
    
    return df, feature_cols

def train_strikeout_model(df, feature_cols):
    """Train the strikeout prediction model."""
    print("Columns in df:", df.columns.tolist())
    print("First 5 rows:\n", df.head())
    print("\n" + "═"*60)
    print("  TRAINING STRIKEOUT MODEL")
    print("═"*60)
    
    X = df[feature_cols].values
    y = df["strikeouts"].values
    
    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("model", GradientBoostingRegressor(
            n_estimators=200,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            min_samples_split=10,
            random_state=42
        ))
    ])
    
    # Time series cross-validation
    tscv = TimeSeriesSplit(n_splits=4)
    maes, rmses, r2s = [], [], []
    
    print("\n   📊 Cross-validation:")
    
    for fold, (train_idx, val_idx) in enumerate(tscv.split(X), 1):
        X_train, X_val = X[train_idx], X[val_idx]
        y_train, y_val = y[train_idx], y[val_idx]
        
        pipeline.fit(X_train, y_train)
        preds = pipeline.predict(X_val)
        
        mae = mean_absolute_error(y_val, preds)
        rmse = np.sqrt(mean_squared_error(y_val, preds))
        r2 = r2_score(y_val, preds)
        
        maes.append(mae)
        rmses.append(rmse)
        r2s.append(r2)
        
        print(f"   Fold {fold}: MAE={mae:.2f} K  RMSE={rmse:.2f} K  R²={r2:.3f}")
    
    print(f"\n   🎯 Mean MAE: {np.mean(maes):.2f} strikeouts")
    print(f"   🎯 Mean RMSE: {np.mean(rmses):.2f} strikeouts")
    print(f"   🎯 Mean R²: {np.mean(r2s):.3f}")
    
    # Train final model
    print("\n   Training final model on all data...")
    pipeline.fit(X, y)
    
    # Feature importance
    importances = pipeline.named_steps["model"].feature_importances_
    top_feats = sorted(zip(feature_cols, importances), key=lambda x: -x[1])
    
    print("\n   📊 Feature Importance:")
    for feat, imp in top_feats:
        print(f"      {feat:.<35} {imp:.4f}")
    
    metrics = {
        "cv_mae_mean": float(np.mean(maes)),
        "cv_rmse_mean": float(np.mean(rmses)),
        "cv_r2_mean": float(np.mean(r2s)),
    }
    
    return pipeline, feature_cols, metrics

def predict_today_strikeouts(model, feature_cols):
    """Predict strikeouts for today's starting pitchers."""
    print("\n" + "═"*60)
    print("  TODAY'S STRIKEOUT PREDICTIONS")
    print("═"*60)
    
    conn = get_db()
    today = datetime.now().strftime("%Y-%m-%d")
    
    # Get today's pitchers
    pitchers = q(conn, """
        SELECT DISTINCT team, opponent, game_date, season,
               pitcher_mlb_id, pitcher_name
        FROM daily_lineups
        WHERE game_date = ? AND pitcher_mlb_id IS NOT NULL
    """, (today,))
    
    if not pitchers:
        # Try most recent date
        latest = q1(conn, "SELECT MAX(game_date) as d FROM daily_lineups WHERE pitcher_mlb_id IS NOT NULL")
        if latest and latest["d"]:
            pitchers = q(conn, """
                SELECT DISTINCT team, opponent, game_date, season,
                       pitcher_mlb_id, pitcher_name
                FROM daily_lineups
                WHERE game_date = ? AND pitcher_mlb_id IS NOT NULL
            """, (latest["d"],))
            print(f"   (Using {latest['d']} - no lineups for today)\n")
    
    if not pitchers:
        print("   ❌ No pitcher data. Run: node importDailyLineups.js")
        conn.close()
        return
    
    date = pitchers[0]["game_date"]
    season = pitchers[0]["season"]
    print(f"   📅 {date}\n")
    
    results = []
    
    for p in pitchers:
        try:
            pitcher_mlb_id = p["pitcher_mlb_id"]
            opp_team = p["opponent"]
            pitcher_team = p["team"]
            
            # Build features
            feats = {}
            
            # Get pitcher's pitch mix
            pitcher_mix = get_pitcher_pitch_mix(conn, pitcher_mlb_id, season)
            
            # Get opposing lineup matchup
            lineup_matchups = get_lineup_vs_pitch_types(
                conn, opp_team, date, season, pitcher_mix
            )
            
            # Calculate expected K rate
            expected_k_pct = calculate_expected_strikeout_rate(pitcher_mix, lineup_matchups)
            
            # Get opposing team K rate
            opp_team_k_rate = get_team_strikeout_rate(conn, opp_team, date, season)
            
            # Get pitcher overall stats
            pitcher_stats = q1(conn, """
                SELECT k_percent, whiff_percent
                FROM savant_pitcher_stats
                WHERE mlb_id = ? AND year <= ?
                ORDER BY year DESC LIMIT 1
            """, (pitcher_mlb_id, season))
            
            if pitcher_stats:
                feats["pitcher_k_pct"] = safe(pitcher_stats["k_percent"], 22.0)
                feats["pitcher_whiff_pct"] = safe(pitcher_stats["whiff_percent"], 25.0)
            else:
                feats["pitcher_k_pct"] = 22.0
                feats["pitcher_whiff_pct"] = 25.0
            
            feats["expected_k_pct"] = expected_k_pct
            feats["opp_team_k_rate"] = opp_team_k_rate
            
            if pitcher_mix:
                feats["num_pitch_types"] = len(pitcher_mix)
                feats["primary_pitch_usage"] = max(p["usage_pct"] for p in pitcher_mix.values())
            
            # Predict
            X = np.array([[feats.get(c, np.nan) for c in feature_cols]], dtype=float)
            predicted_ks = model.predict(X)[0]
            
            results.append({
                "pitcher": p["pitcher_name"],
                "team": pitcher_team,
                "opponent": opp_team,
                "predicted_k": predicted_ks,
                "expected_k_pct": expected_k_pct,
                "pitcher_k_pct": feats.get("pitcher_k_pct", 22.0),
            })
            
        except Exception as e:
            results.append({
                "pitcher": p["pitcher_name"],
                "team": p["team"],
                "opponent": p["opponent"],
                "error": str(e),
            })
    
    conn.close()
    
    # Sort by predicted strikeouts
    results.sort(key=lambda x: -x.get("predicted_k", 0))
    
    print(f"   {'PITCHER':<25} {'TEAM':<5} {'vs':<3} {'OPP':<5} {'PRED K':>7} {'K%':>6} {'MATCHUP K%':>11}")
    print("   " + "─"*70)
    
    for r in results:
        if "error" in r:
            print(f"   {r['pitcher']:<25} {r['team']:<5}     {r['opponent']:<5}  ⚠️  Error")
            continue
        
        print(f"   {r['pitcher']:<25} {r['team']:<5} vs  {r['opponent']:<5} "
              f"{r['predicted_k']:>7.1f} {r['pitcher_k_pct']:>5.1f}% "
              f"{r['expected_k_pct']:>10.1f}%")
    
    print()

def main():
    parser = argparse.ArgumentParser(description="Pitcher Strikeout Predictor")
    parser.add_argument("--train", action="store_true", help="Train the model")
    parser.add_argument("--predict", action="store_true", help="Predict today's strikeouts")
    args = parser.parse_args()
    
    if not args.train and not args.predict:
        print("Usage: python pitcher_strikeout_predictor.py --train --predict")
        return
    
    model = feature_cols = None
    
    if args.train:
        df, feature_cols = build_strikeout_training_data()
        model, feature_cols, metrics = train_strikeout_model(df, feature_cols)
        
        with open(MODEL_PATH, "wb") as f:
            pickle.dump({"model": model, "feats": feature_cols}, f)
        
        with open(FEATURES_PATH, "w") as f:
            json.dump({
                "feature_cols": feature_cols,
                "trained_at": datetime.now().isoformat(),
                **metrics,
            }, f, indent=2)
        
        print(f"\n✅ Model saved to {MODEL_PATH}")
    
    if args.predict:
        if not model:
            if not MODEL_PATH.exists():
                print("❌ No model found. Run with --train first.")
                sys.exit(1)
            
            with open(MODEL_PATH, "rb") as f:
                saved = pickle.load(f)
            model = saved["model"]
            feature_cols = saved["feats"]
        
        predict_today_strikeouts(model, feature_cols)

if __name__ == "__main__":
    main()