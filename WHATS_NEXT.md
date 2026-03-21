# CourtIQ — What's Next

## Current State (all built & live on Railway)
- ESPN data: scores, injuries, news, standings
- NBA Stats API: OFF/DEF ratings, pace, eFG%, net rating (blended into power rating)
- Multi-book odds: DraftKings, FanDuel, BetMGM, Caesars — consensus line + sharp action detection
- Confirmed lineups: starters + OUT/Doubtful/Questionable per game card
- Server-side caching: ESPN 5min, NBA 30min, Odds 30min
- Claude rate limiting (max 3 concurrent analyses)
- Tooltips, onboarding modal, color-coded stats
- README, folder structure (public/), async server

---

## Next Features (in priority order)

### 1. Player Props
- The Odds API already supports props — already paying for it
- Markets: points, rebounds, assists, 3-pointers per player
- Claude analyzes player vs defensive matchup data
- Whole new betting vertical, props markets are less sharp than spreads
- Add a "Props" tab to CourtIQ

### 2. Public Betting %
- Shows % of bets and money on each side
- Sharps fade the public — if 80% on Lakers but line moves to Celtics = sharp money
- Source: Covers.com (scrapeable) or paid API
- Medium-hard effort

### 3. Situational Betting Trends
- Hard data on teams in specific spots:
  - 3rd game in 4 nights
  - Home after long road trip
  - Division rival games
  - After a blowout loss (bounce-back spots)
- Build from ESPN schedule data we already have

### 4. Injury Impact Scoring
- Quantify player absences: "Curry OUT = GSW -8.2 pts"
- Cross-reference player minutes + plus/minus from NBA Stats API (already connected)
- Currently injuries are listed — this makes them actionable numbers

### 5. Historical ATS Trends
- Team ATS record in specific situations
- Coach tendencies ATS
- Build from existing schedule data

### 6. User Accounts (Google OAuth + Database)
- Login with Google/Gmail
- Pick history + notes sync across all devices (not just browser)
- Requires: Railway Postgres, Google Cloud Console OAuth app, session management
- Foundation for future: email alerts, leaderboards, personalized summaries
- SKIP until ready to make CourtIQ a real multi-user product

---

## Keys in .env (never commit)
- ANTHROPIC_API_KEY — Claude AI
- ODDS_API_KEY — The Odds API (a108a0734cacbb9b738b9f206f594d02) — 500 req/month free tier, ~300-400 used/month with 30min cache

## Railway
- Auto-deploys on every push to master
- Add env vars in Railway dashboard → Service → Variables
