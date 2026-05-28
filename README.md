# DiamondEdge

A full-stack MLB prediction and analytics platform built from scratch. Generates daily predictions for game winners, pitcher strikeouts, and home run candidates using custom machine learning models trained on historical Statcast and Retrosheet data.

![Node.js](https://img.shields.io/badge/Node.js-Express-green) ![Python](https://img.shields.io/badge/Python-scikit--learn-blue) ![SQLite](https://img.shields.io/badge/Database-SQLite-lightgrey)

---

## Features

- **Game winner predictions** — ML model weighing team Elo ratings, recent form, park factors, weather, bullpen fatigue, and Vegas implied probabilities
- **Strikeout predictions** — Per-pitcher projections using pitch mix, whiff rate, chase rate, and opposing lineup contact profiles
- **Home run predictions** — Per-batter projections using Statcast exit velocity, launch angle, park dimensions, and wind conditions
- **Live score updates** — Cards update in real time during games via ESPN Scoreboard API (5-second polling)
- **Betting odds** — Moneyline, run line, and O/U pulled from OddsAPI and ESPN across multiple bookmakers
- **Lineup tracking** — Starting lineups scraped and imported automatically every 30 minutes; predictions refresh when lineups change
- **Historical record** — Full game history with pregame odds, actual results, and model accuracy tracking by date

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js, Express |
| Database | SQLite (WAL mode, 20+ tables) |
| ML models | Python, scikit-learn |
| Live data | ESPN Scoreboard API |
| Odds data | OddsAPI + ESPN odds |
| Lineup scraping | Node.js + Selenium |
| Frontend | Vanilla JS, HTML/CSS (single-page app) |

---

## Data Pipeline

Historical data was imported from multiple sources and normalized into a unified SQLite schema:

- **Retrosheet** game logs (1871–2025) — results, park IDs, conditions
- **Baseball Savant / Statcast** — pitch type splits, expected stats, barrel rates, sprint speed
- **FanGraphs** — plate discipline metrics (Z-swing%, O-swing%, contact rates)
- **MLB Stats API** — live rosters, season stats, recent game logs, lineup data
- **OddsAPI / ESPN** — pregame and live betting lines

Import scripts in the repo handle ingestion, normalization, and deduplication for each source.

---

## Architecture

```
ESPN / OddsAPI
      │
      ▼
  server.js  ──── SQLite (mlb.db)
      │                  │
      │            Python predictors
      │            (winners / SO / HR)
      │
      ▼
  public/index.html  (single-page app)
```

The server pre-warms predictions on a 30-minute cycle after each lineup refresh. Frontend requests are served from an in-memory cache; the model only re-runs when lineups change or a manual refresh is triggered. Live game state is patched onto existing cards via a 5-second polling loop without re-rendering the page.

---

## Prediction methodology is not included in this repository.
