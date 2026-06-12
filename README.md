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
| Frontend | Next.js + TypeScript + Tailwind (`frontend/`); legacy vanilla JS in `public/` |

---

## Running the App

### Prerequisites

- **Node.js** 18+ (`node -v`)
- **Python** 3.9+ (`python3 --version`) — required for the prediction models

### 1. Backend (API + legacy UI)

```bash
npm install
```

The predictors run as Python and need a few scientific libraries. Create a
virtualenv once:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install numpy pandas scikit-learn
```

Start the server:

```bash
# macOS / Linux — point the server at the venv's Python:
PYTHON_BIN="$PWD/.venv/bin/python" node server.js

# Windows (the `py` launcher is the default):
node server.js
```

The server listens on **http://localhost:3000** by default. Override with `PORT`
(e.g. `PORT=3100 node server.js`) if that port is taken. It serves the JSON API
under `/api/*` and the legacy single-page UI from `public/`.

> **Config:** an `ODDS_API_KEY` in a `.env` (or `oddsAPI.env`) file enables live
> betting odds. Without it, predictions still work; only odds refreshes are skipped.

### 2. Frontend (Next.js — recommended)

The modern UI lives in [`frontend/`](frontend/) (Next.js + TypeScript + Tailwind).
It calls the backend through a same-origin `/api` proxy.

```bash
cd frontend
npm install
npm run dev            # → http://localhost:3001
```

If the backend isn't on port 3000, point the proxy at it:

```bash
API_ORIGIN=http://localhost:3100 npm run dev
```

Open **http://localhost:3001**. See [`frontend/README.md`](frontend/README.md) for details.

### 3. Generate / refresh predictions

Predictions are built automatically when the backend starts (and every 30 min as
lineups change). To force a refresh while the server is running:

```bash
PYTHON_BIN="$PWD/.venv/bin/python" node refreshPredictions.js
```

> The models read historical game data from `mlb.db`. A fresh database is seeded
> with the current season's results from ESPN on first run; the full historical
> backfill (park factors, weather) uses Retrosheet game logs imported separately.

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
