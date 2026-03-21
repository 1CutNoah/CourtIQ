# CourtIQ
NBA daily betting intelligence — AI-powered game analysis combining statistical modeling with Claude AI.

## What it does
- Pulls today's full NBA slate from ESPN (scores, odds, injuries, news, standings)
- Calculates power ratings and ATS trends for every team
- Accounts for rest/fatigue, back-to-backs, road trips, playoff motivation, and H2H history
- Sends full game context to Claude AI for sharp betting analysis
- Tracks your pick record (W/L/Push) automatically, graded the morning after each game
- Auto-refreshes every 15 minutes and re-analyzes games with significant line movement

## Run locally
1. Add your API key to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Double-click `Launch CourtIQ.bat`
3. Open [http://localhost:3003](http://localhost:3003)

## Deploy (Railway)
Push to the `master` branch on GitHub — Railway auto-deploys on every push.

## Project structure
```
CourtIQ/
├── public/
│   ├── index.html     # Full frontend — UI, data fetching, AI integration
│   ├── sw.js          # Service worker (offline fallback)
│   ├── icon.svg       # App icon
│   └── manifest.json  # PWA manifest
├── server.js          # Node.js backend — serves static files + proxies Claude API
├── package.json
└── .env               # Local secrets (never committed)
```

## Environment variables
| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key from [console.anthropic.com](https://console.anthropic.com) |
| `PORT` | No | Server port (default: 3003) |

## Algorithm
- **Power rating** = 55% overall win% + 45% home/road situational win%
- **B2B penalty** = −14 power points (~3.5 pts)
- **Home court** = +12 power points (~3 pts)
- **Stat pick** fires when model sees ≥1.5pt edge vs the posted spread
- **Claude analysis** layers in qualitative factors the model can't capture
