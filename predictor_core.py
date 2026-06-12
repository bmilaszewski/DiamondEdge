import sqlite3
import pandas as pd
import numpy as np
from datetime import datetime

from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, accuracy_score, log_loss, brier_score_loss
from sklearn.impute import SimpleImputer
from sklearn.ensemble import GradientBoostingClassifier


# =========================
# DB HELPERS
# =========================

def get_conn(db_path="mlb.db"):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def load_games(conn):
    df = pd.read_sql_query("""
        SELECT game_id, game_date, season,
               home_team, away_team,
               home_score, away_score,
               starting_pitcher_home,
               starting_pitcher_away
        FROM game_results
        ORDER BY game_date
    """, conn)

    df["game_date"] = pd.to_datetime(df["game_date"])
    df["home_won"] = (df["home_score"] > df["away_score"]).astype(int)
    df["total_runs"] = df["home_score"] + df["away_score"]

    return df


# =========================
# TEAM ROLLING FEATURES
# =========================

def add_team_rolling(df):
    df = df.sort_values("game_date")

    # Home team rolling
    df["home_win_pct"] = (
        df.groupby("home_team")["home_won"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    # Away win pct (inverse)
    df["away_win_pct"] = (
        df.groupby("away_team")["home_won"]
        .transform(lambda x: (1 - x).shift().rolling(20, min_periods=5).mean())
    )

    # Runs per game
    df["home_rpg"] = (
        df.groupby("home_team")["total_runs"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    df["away_rpg"] = (
        df.groupby("away_team")["total_runs"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    return df


# =========================
# PITCHER FEATURES
# =========================

def get_pitcher_stats(conn, pitcher_name):
    row = conn.execute("""
        SELECT AVG(era) as era,
               AVG(xwoba) as xwoba,
               AVG(whiff_pct) as whiff
        FROM pitcher_stats
        WHERE player_name = ?
    """, (pitcher_name,)).fetchone()

    if not row:
        return 4.50, 0.320, 0.22

    return (
        row["era"] or 4.50,
        row["xwoba"] or 0.320,
        row["whiff"] or 0.22
    )


def add_pitcher_features(conn, df):
    home_era, away_era = [], []
    home_xwoba, away_xwoba = [], []

    for _, row in df.iterrows():
        h_era, h_xw, _ = get_pitcher_stats(conn, row["starting_pitcher_home"])
        a_era, a_xw, _ = get_pitcher_stats(conn, row["starting_pitcher_away"])

        home_era.append(h_era)
        away_era.append(a_era)
        home_xwoba.append(h_xw)
        away_xwoba.append(a_xw)

    df["home_sp_era"] = home_era
    df["away_sp_era"] = away_era
    df["home_sp_xwoba"] = home_xwoba
    df["away_sp_xwoba"] = away_xwoba

    return df


# =========================
# FEATURE ENGINEERING
# =========================

def add_differences(df):
    df["win_pct_diff"] = df["home_win_pct"] - df["away_win_pct"]
    df["rpg_diff"] = df["home_rpg"] - df["away_rpg"]
    df["era_diff"] = df["away_sp_era"] - df["home_sp_era"]
    df["xwoba_diff"] = df["away_sp_xwoba"] - df["home_sp_xwoba"]
    return df


def build_feature_matrix(df):
    features = [
        "home_win_pct", "away_win_pct",
        "home_rpg", "away_rpg",
        "home_sp_era", "away_sp_era",
        "home_sp_xwoba", "away_sp_xwoba",
        "win_pct_diff", "rpg_diff",
        "era_diff", "xwoba_diff"
    ]

    X = df[features]
    y = df["home_won"]

    return X, y, features


# =========================
# MODEL TRAINING
# =========================

def train_model(X, y):
    imputer = SimpleImputer(strategy="mean")
    X_imp = imputer.fit_transform(X)

    tscv = TimeSeriesSplit(n_splits=5)

    aucs = []

    for train_idx, test_idx in tscv.split(X_imp):
        X_train, X_test = X_imp[train_idx], X_imp[test_idx]
        y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]

        model = GradientBoostingClassifier()
        model.fit(X_train, y_train)

        probs = model.predict_proba(X_test)[:, 1]
        auc = roc_auc_score(y_test, probs)
        aucs.append(auc)

        print(f"AUC: {auc:.3f}")

    print(f"\nMean AUC: {np.mean(aucs):.3f}")

    final_model = GradientBoostingClassifier()
    final_model.fit(X_imp, y)

    return final_model, imputer


# =========================
# PREDICTIONS
# =========================

def predict_today(model, imputer, df, feature_cols):
    latest = df.tail(15).copy()

    X = latest[feature_cols]
    X_imp = imputer.transform(X)

    probs = model.predict_proba(X_imp)[:, 1]

    latest["home_win_prob"] = probs
    latest["away_win_prob"] = 1 - probs

    print("\nTODAY'S PREDICTIONS\n")

    for _, r in latest.iterrows():
        print(f"{r['away_team']} @ {r['home_team']}  "
              f"{r['home_win_prob']:.3f} / {r['away_win_prob']:.3f}")


# =========================
# MAIN
# =========================

def main():
    conn = get_conn()

    print("Loading games...")
    df = load_games(conn)

    print("Building rolling stats...")
    df = add_team_rolling(df)

    print("Adding pitcher stats...")
    df = add_pitcher_features(conn, df)

    print("Engineering features...")
    df = add_differences(df)

    print("Building matrix...")
    X, y, feature_cols = build_feature_matrix(df)

    print("Training model...")
    model, imputer = train_model(X, y)

    print("Predicting...")
    predict_today(model, imputer, df, feature_cols)


if __name__ == "__main__":
    main()