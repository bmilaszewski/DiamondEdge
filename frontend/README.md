# DiamondEdge — Frontend (Next.js)

A Next.js 15 (App Router) + TypeScript + Tailwind CSS v4 rebuild of the DiamondEdge
MLB-analytics frontend. It renders the same data as the legacy `public/*.html` pages
but as a typed, component-based app with a refined "sports-terminal" design system.

## Architecture

- **Framework:** Next.js 15 App Router, React 19, TypeScript (strict).
- **Styling:** Tailwind CSS v4 (CSS-first `@theme` in `app/globals.css`) + a small set of
  component primitives. Fonts (Bebas Neue / DM Mono / DM Sans) load via `next/font`.
- **Data:** the existing Express API in `../server.js` is the backend. The frontend calls
  same-origin `/api/*` URLs; `next.config.mjs` **rewrites** those to the Express server so
  there's no CORS and the code matches the legacy app.

```
frontend/
  app/
    layout.tsx            # fonts + root html
    globals.css           # design tokens, atmosphere, motion, primitives
    page.tsx              # "/"  → 5-tab prediction hub
    dashboard/page.tsx    # "/dashboard"
    predictions/page.tsx  # "/predictions" (pick detail + reason modal)
  components/
    Shell.tsx             # sidebar + topbar app shell
    HubClient.tsx         # tab + date-nav orchestration
    ui.tsx                # DateNav, StatStrip, Bar, SortTable, states
    tabs/                 # Winners, Strikeouts, Homeruns, Leaderboards
    DashboardClient.tsx
    PredictionsClient.tsx
  lib/
    api.ts                # typed fetch client
    types.ts              # API response interfaces
    teams.ts              # abbrev normalization + MLB logo ids
    format.ts             # number / date / odds helpers
```

## Running it

The frontend needs the Express backend running for data.

```bash
# 1) Backend (from repo root). Port is configurable via PORT (defaults to 3000).
node server.js                 # → http://localhost:3000
# or run it elsewhere:
PORT=3100 node server.js       # → http://localhost:3100

# 2) Frontend (from this folder). Dev server runs on :3001.
cd frontend
npm install
npm run dev                    # → http://localhost:3001
```

If the backend is **not** on `http://localhost:3000`, point the proxy at it:

```bash
API_ORIGIN=http://localhost:3100 npm run dev
```

`npm run build` produces an optimized production build; `npm start` serves it on :3001.

## Notes

- The **Game Winners / Strikeouts / Home Runs** tabs depend on the prediction pipeline,
  which shells out to the (proprietary, git-ignored) Python models via `node`. Where those
  models + a Python interpreter aren't available, those endpoints return empty and the tabs
  show a graceful empty state. The **Hitters / Pitchers** leaderboards read straight from
  `mlb.db` and work without Python.
- Team logos are loaded from `mlbstatic.com`; the legacy `/img/*` assets are also proxied.
