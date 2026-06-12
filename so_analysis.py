"""
Deep correlation analysis: which stats predict per-game pitcher K totals?
Builds a game-level dataset from historical_lineups (actual per-game batter K data)
joined with savant_pitcher_stats and savant_hitter_stats lineup averages.
"""
import sqlite3, sys
import numpy as np
import pandas as pd
from pathlib import Path
from collections import Counter

DB_PATH = Path(__file__).parent / "mlb.db"

def safe(v, d=0.0):
    if v is None: return d
    try:
        f = float(v)
        return d if (f != f or abs(f) > 1e9) else f
    except: return d

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = lambda c, r: dict(zip([x[0] for x in c.description], r))
    return conn

def main():
    conn = connect()
    print("=" * 70)
    print("  STRIKEOUT DEEP CORRELATION ANALYSIS")
    print("=" * 70)

    # -- Step 1: Per-game K totals from historical_lineups ------------------
    # games=1 per row; strikeouts = actual Ks in that plate appearance
    # Group by (pitcher, game_date, batting_team) — use MAX(season) to
    # handle doubleheaders (same date) by taking only the primary entry per
    # batter (max batting_order wins ties), capped at 1 record per batter/game.
    print("\n[1] Building per-game K dataset from historical_lineups ...")

    game_rows = conn.execute("""
        SELECT
            h.pitcher_mlb_id,
            h.pitcher_name,
            h.game_date,
            h.season,
            h.team                           AS batting_team,
            COUNT(DISTINCT h.mlb_id)         AS n_batters,
            SUM(s.ks)                        AS game_ks,
            SUM(s.ab)                        AS total_ab,
            SUM(s.walks)                     AS game_bb
        FROM historical_lineups h
        JOIN (
            -- take ONE row per batter per game (handle doubleheaders)
            SELECT pitcher_mlb_id, game_date, team, mlb_id,
                   MAX(strikeouts) AS ks,
                   MAX(at_bats)    AS ab,
                   MAX(walks)      AS walks
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
    """).fetchall()

    ks_vals = [r["game_ks"] for r in game_rows]
    print(f"  {len(game_rows):,} pitcher-game rows")
    print(f"  Game Ks:  mean={np.mean(ks_vals):.2f}  "
          f"median={np.median(ks_vals):.1f}  "
          f"std={np.std(ks_vals):.2f}  "
          f"range={int(min(ks_vals))}-{int(max(ks_vals))}")
    dist = Counter(int(k) for k in ks_vals)
    print("  K distribution:", dict(sorted(dist.items())))

    # -- Step 2: Load lookup caches -----------------------------------------
    print("\n[2] Loading stat caches ...")

    pitcher_cache = {}
    for r in conn.execute("""
        SELECT mlb_id, season, k_percent, whiff_percent, oz_swing_percent,
               z_swing_miss_percent, iz_contact_percent, f_strike_percent,
               meatball_percent, bb_percent, barrel_batted_rate,
               exit_velocity_avg, hard_hit_percent, groundballs_percent,
               flyballs_percent, linedrives_percent, popups_percent,
               swing_percent, z_swing_percent,
               fastball_avg_speed, fastball_avg_spin,
               breaking_avg_speed, breaking_avg_spin,
               offspeed_avg_speed, offspeed_avg_spin,
               ff_avg_speed, ff_avg_spin,
               sl_avg_speed, sl_avg_spin, sl_avg_break_x, sl_avg_break_z,
               ch_avg_speed, cu_avg_speed, st_avg_speed,
               innings_pitched, pa, games, strikeouts
        FROM savant_pitcher_stats WHERE pa >= 100
    """).fetchall():
        # keep most recent season
        key = (r["mlb_id"], r["season"])
        pitcher_cache[key] = r
    print(f"  {len(pitcher_cache):,} pitcher-seasons loaded")

    hitter_cache = {}
    for r in conn.execute("""
        SELECT mlb_id, season, k_percent, whiff_percent, oz_swing_percent,
               z_swing_miss_percent, iz_contact_percent, f_strike_percent,
               swing_percent, z_swing_percent, meatball_swing_pct,
               barrel_batted_rate, exit_velocity_avg, hard_hit_percent,
               bat_speed, fast_swing_rate, sprint_speed,
               groundballs_percent, flyballs_percent, linedrives_percent,
               woba, xwoba, slg_percent, babip, pa
        FROM savant_hitter_stats WHERE pa >= 50
    """).fetchall():
        hitter_cache[(r["mlb_id"], r["season"])] = r
    print(f"  {len(hitter_cache):,} hitter-seasons loaded")

    pitch_mix_cache = {}
    for r in conn.execute("""
        SELECT mlb_id, year, pitch_type, whiff_percent, put_away_percent, pitches, pa
        FROM pitcher_pitch_type WHERE pitches >= 50
    """).fetchall():
        key = (r["mlb_id"], r["year"])
        if key not in pitch_mix_cache:
            pitch_mix_cache[key] = {}
        pitch_mix_cache[key][r["pitch_type"]] = r
    print(f"  {len(pitch_mix_cache):,} pitcher pitch-mix seasons loaded")

    # Per-game batter lists
    game_batters = {}
    for r in conn.execute("""
        SELECT pitcher_mlb_id, game_date, team, mlb_id, season, handedness
        FROM historical_lineups
        WHERE pitcher_mlb_id IS NOT NULL
          AND batting_order BETWEEN 1 AND 9
          AND at_bats >= 1
    """).fetchall():
        key = (r["pitcher_mlb_id"], r["game_date"], r["team"])
        if key not in game_batters:
            game_batters[key] = []
        # Deduplicate per batter per game
        if not any(b["mlb_id"] == r["mlb_id"] for b in game_batters[key]):
            game_batters[key].append(r)
    print(f"  {len(game_batters):,} pitcher-game lineup keys")

    # -- Step 3: Build feature matrix ---------------------------------------
    print("\n[3] Building feature matrix ...")
    dataset = []
    skipped = {"no_pitcher": 0, "no_lineup": 0}

    for g in game_rows:
        pid    = g["pitcher_mlb_id"]
        season = g["season"]

        pstats = (pitcher_cache.get((pid, season))
                  or pitcher_cache.get((pid, season - 1)))
        if not pstats:
            skipped["no_pitcher"] += 1
            continue

        batter_list = game_batters.get((pid, g["game_date"], g["batting_team"]), [])
        hstats = []
        for b in batter_list:
            s = b["season"]
            h = hitter_cache.get((b["mlb_id"], s)) or hitter_cache.get((b["mlb_id"], s - 1))
            if h:
                hstats.append((h, b.get("handedness", "R")))

        if len(hstats) < 4:
            skipped["no_lineup"] += 1
            continue

        def avg_h(col, default=0.0):
            vals = [safe(h[col], default) for h, _ in hstats if col in h]
            return float(np.mean(vals)) if vals else default

        # Arsenal aggregates
        pmix = (pitch_mix_cache.get((pid, season))
                or pitch_mix_cache.get((pid, season - 1)) or {})
        if pmix:
            tot = sum(safe(v["pitches"]) for v in pmix.values())
            w_whiff    = sum(safe(v["whiff_percent"], 25) * safe(v["pitches"]) for v in pmix.values()) / max(tot, 1)
            w_put_away = sum(safe(v["put_away_percent"], 20) * safe(v["pitches"]) for v in pmix.values()) / max(tot, 1)
            n_pitch_types = len(pmix)
            # FB/breaking/offspeed split whiff
            fb_types  = {"FF", "SI", "FC"}
            brk_types = {"SL", "CU", "KC", "ST", "SV"}
            os_types  = {"CH", "FS", "FO", "SC"}
            def pitch_group_whiff(types):
                items = [(v["whiff_percent"], v["pitches"]) for pt, v in pmix.items() if pt in types]
                if not items: return w_whiff
                t = sum(p for _, p in items)
                return sum(w * p for w, p in items) / max(t, 1)
            fb_whiff  = pitch_group_whiff(fb_types)
            brk_whiff = pitch_group_whiff(brk_types)
            os_whiff  = pitch_group_whiff(os_types)
        else:
            w_whiff = safe(pstats["whiff_percent"], 25)
            w_put_away = 20.0
            n_pitch_types = 3
            fb_whiff = brk_whiff = os_whiff = w_whiff

        # Batters faced / innings proxy
        bf_per_start = safe(pstats["pa"]) / max(safe(pstats["games"]), 1)
        ip_per_start = safe(pstats["innings_pitched"]) / max(safe(pstats["games"]), 1)

        # Handedness matchup: fraction RHH vs LHH
        n_rhh = sum(1 for _, hand in hstats if hand == "R")
        n_lhh = sum(1 for _, hand in hstats if hand == "L")
        pct_rhh = n_rhh / max(len(hstats), 1)

        # Lineup K% split by handedness for pitcher's hand
        rh_hitters   = [h for h, hand in hstats if hand == "R"]
        lh_hitters   = [h for h, hand in hstats if hand == "L"]
        rh_k_pct = float(np.mean([safe(h["k_percent"], 22) for h in rh_hitters])) if rh_hitters else avg_h("k_percent", 22)
        lh_k_pct = float(np.mean([safe(h["k_percent"], 22) for h in lh_hitters])) if lh_hitters else avg_h("k_percent", 22)

        row = {
            # -- Target ------------------------------------------------------
            "game_ks":           g["game_ks"],
            "n_batters":         g["n_batters"],
            "total_ab":          g["total_ab"],
            "season":            season,
            # -- Pitcher: overall plate discipline ----------------------------
            "p_k_pct":           safe(pstats["k_percent"], 22),
            "p_whiff":           safe(pstats["whiff_percent"], 25),
            "p_chase":           safe(pstats["oz_swing_percent"], 30),
            "p_z_miss":          safe(pstats["z_swing_miss_percent"], 10),
            "p_iz_contact":      safe(pstats["iz_contact_percent"], 84),
            "p_f_strike":        safe(pstats["f_strike_percent"], 60),
            "p_meatball":        safe(pstats["meatball_percent"], 8),
            "p_bb_pct":          safe(pstats["bb_percent"], 8),
            "p_swing":           safe(pstats["swing_percent"], 47),
            "p_z_swing":         safe(pstats["z_swing_percent"], 67),
            # -- Pitcher: contact quality allowed ----------------------------
            "p_barrel":          safe(pstats["barrel_batted_rate"], 8),
            "p_ev":              safe(pstats["exit_velocity_avg"], 88),
            "p_hard_hit":        safe(pstats["hard_hit_percent"], 35),
            "p_gb_pct":          safe(pstats["groundballs_percent"], 43),
            "p_fb_pct":          safe(pstats["flyballs_percent"], 35),
            "p_ld_pct":          safe(pstats["linedrives_percent"], 22),
            # -- Pitcher: arsenal --------------------------------------------
            "p_arsenal_whiff":   w_whiff,
            "p_put_away":        w_put_away,
            "p_n_pitch_types":   n_pitch_types,
            "p_fb_whiff":        fb_whiff,
            "p_brk_whiff":       brk_whiff,
            "p_os_whiff":        os_whiff,
            # -- Pitcher: velocity / movement --------------------------------
            "p_ff_speed":        safe(pstats["ff_avg_speed"], 93),
            "p_ff_spin":         safe(pstats["ff_avg_spin"], 2200),
            "p_sl_speed":        safe(pstats["sl_avg_speed"], 85),
            "p_sl_spin":         safe(pstats["sl_avg_spin"], 2500),
            "p_sl_break_x":      safe(pstats["sl_avg_break_x"], 0),
            "p_sl_break_z":      safe(pstats["sl_avg_break_z"], 0),
            "p_ch_speed":        safe(pstats["ch_avg_speed"], 83),
            "p_break_speed":     safe(pstats["breaking_avg_speed"], 82),
            "p_break_spin":      safe(pstats["breaking_avg_spin"], 2500),
            # -- Pitcher: workload proxy --------------------------------------
            "p_bf_per_start":    bf_per_start,
            "p_ip_per_start":    ip_per_start,
            # -- Lineup (hitter averages) -------------------------------------
            "l_k_pct":           avg_h("k_percent", 22),
            "l_whiff":           avg_h("whiff_percent", 25),
            "l_chase":           avg_h("oz_swing_percent", 30),
            "l_iz_contact":      avg_h("iz_contact_percent", 84),
            "l_z_miss":          avg_h("z_swing_miss_percent", 10),
            "l_f_strike":        avg_h("f_strike_percent", 60),
            "l_swing":           avg_h("swing_percent", 47),
            "l_z_swing":         avg_h("z_swing_percent", 67),
            "l_barrel":          avg_h("barrel_batted_rate", 8),
            "l_ev":              avg_h("exit_velocity_avg", 88),
            "l_hard_hit":        avg_h("hard_hit_percent", 35),
            "l_bat_speed":       avg_h("bat_speed", 72),
            "l_fast_swing":      avg_h("fast_swing_rate", 25),
            "l_gb_pct":          avg_h("groundballs_percent", 43),
            "l_fb_pct":          avg_h("flyballs_percent", 35),
            "l_woba":            avg_h("woba", 0.320),
            "l_xwoba":           avg_h("xwoba", 0.320),
            # -- Handedness matchup -------------------------------------------
            "pct_rhh":           pct_rhh,
            "rh_k_pct":          rh_k_pct,
            "lh_k_pct":          lh_k_pct,
            # -- Interaction terms --------------------------------------------
            "p_whiff_x_l_iz":    safe(pstats["whiff_percent"], 25) * avg_h("iz_contact_percent", 84) / 100,
            "p_k_x_l_k":         safe(pstats["k_percent"], 22) * avg_h("k_percent", 22) / 100,
            "p_arsenal_x_l_chase": w_whiff * avg_h("oz_swing_percent", 30) / 100,
        }
        dataset.append(row)

    print(f"  Built {len(dataset):,} rows  (skipped: {skipped})")

    # -- Step 4: Correlations -----------------------------------------------
    print("\n[4] Pearson correlations with game_ks")
    df = pd.DataFrame(dataset)
    target = df["game_ks"]
    meta   = {"game_ks", "n_batters", "total_ab", "season"}

    corrs = []
    for col in df.columns:
        if col in meta: continue
        x = pd.to_numeric(df[col], errors="coerce")
        mask = x.notna() & target.notna()
        if mask.sum() < 100: continue
        r = float(np.corrcoef(x[mask].values, target[mask].values)[0, 1])
        if np.isnan(r): continue
        corrs.append((col, r, r**2, int(mask.sum())))

    corrs.sort(key=lambda x: -abs(x[1]))

    print(f"\n  {'Feature':<35} {'r':>8}  {'R2':>8}  {'n':>7}")
    print("  " + "-" * 62)
    for col, r, r2, n in corrs:
        direction = "+" if r > 0 else "-"
        bar = "#" * int(abs(r) * 20)
        print(f"  {col:<35} {r:>+8.4f}  {r2:>8.4f}  {n:>7,}  {direction} {bar}")

    # -- Step 5: Group means analysis ---------------------------------------
    print("\n[5] K distribution by decile of top features")
    top_features = [c for c, r, r2, n in corrs[:6]]
    for feat in top_features:
        x = pd.to_numeric(df[feat], errors="coerce")
        valid = x.notna() & target.notna()
        x_v, y_v = x[valid], target[valid]
        try:
            q_labels = pd.qcut(x_v, q=5, labels=["Q1(lo)", "Q2", "Q3", "Q4", "Q5(hi)"])
            means = y_v.groupby(q_labels).mean()
            print(f"\n  {feat}:")
            for q, m in means.items():
                print(f"    {q}: avg {m:.2f} Ks")
        except Exception as e:
            print(f"  {feat}: (skipped - {e})")

    # -- Step 6: IP / BF impact --------------------------------------------
    print("\n[6] Are more innings pitched = more Ks? (obviously yes, but how much?)")
    x = pd.to_numeric(df["p_ip_per_start"], errors="coerce")
    valid = x.notna() & target.notna()
    r_ip = float(np.corrcoef(x[valid].values, target[valid].values)[0, 1])
    print(f"  p_ip_per_start vs game_ks: r={r_ip:+.4f}  R2={r_ip**2:.4f}")
    x = pd.to_numeric(df["p_bf_per_start"], errors="coerce")
    valid = x.notna() & target.notna()
    r_bf = float(np.corrcoef(x[valid].values, target[valid].values)[0, 1])
    print(f"  p_bf_per_start vs game_ks: r={r_bf:+.4f}  R2={r_bf**2:.4f}")

    # K per BF — controlling for workload
    df["ks_per_ab"] = df["game_ks"] / df["total_ab"].clip(lower=1)
    print("\n[7] Correlations with K/AB (controlling for lineup length)")
    corrs2 = []
    target2 = df["ks_per_ab"]
    for col in df.columns:
        if col in meta or col in ("ks_per_ab",): continue
        x = pd.to_numeric(df[col], errors="coerce")
        mask = x.notna() & target2.notna()
        if mask.sum() < 100: continue
        r = float(np.corrcoef(x[mask].values, target2[mask].values)[0, 1])
        if np.isnan(r): continue
        corrs2.append((col, r, r**2, int(mask.sum())))

    corrs2.sort(key=lambda x: -abs(x[1]))
    print(f"\n  {'Feature':<35} {'r':>8}  {'R2':>8}")
    print("  " + "-" * 55)
    for col, r, r2, n in corrs2[:25]:
        direction = "+" if r > 0 else "-"
        print(f"  {col:<35} {r:>+8.4f}  {r2:>8.4f}  {direction}")

    # -- Step 7: Multivariate regression preview ----------------------------
    print("\n[8] Quick OLS regression with top features (feature importance)")
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer
    from sklearn.metrics import mean_absolute_error, r2_score as sk_r2

    top_cols = [c for c, r, r2, n in corrs[:20]]
    X = df[top_cols].values.astype(float)
    y = df["game_ks"].values.astype(float)

    imp = SimpleImputer(strategy="median")
    X   = imp.fit_transform(X)
    sc  = StandardScaler()
    X   = sc.fit_transform(X)

    ridge = Ridge(alpha=1.0)
    ridge.fit(X, y)
    preds = ridge.predict(X)
    mae  = mean_absolute_error(y, preds)
    r2   = sk_r2(y, preds)
    print(f"  Ridge in-sample MAE={mae:.2f} Ks  R2={r2:.4f}")
    print()
    for feat, coef in sorted(zip(top_cols, ridge.coef_), key=lambda x: -abs(x[1])):
        bar = "#" * int(abs(coef) * 8)
        sign = "+" if coef > 0 else ""
        print(f"  {feat:<35} {sign}{coef:.4f}  {bar}")

    conn.close()
    print("\n[Done]")

if __name__ == "__main__":
    main()
