# Newsy - News Briefing App

## Overview
Newsy is a personalized news briefing app that delivers curated daily briefings based on user preferences. It fetches real news from multiple sources and uses AI to synthesize them into professional, presidential-style audio briefings.

## Briefing Philosophy
- Mental model: President's Daily Briefing
- Target audience: Well-educated business professionals interested in geopolitics
- Audio-first: Designed to be listened to while getting ready or commuting
- Never mentions user's name (to avoid mispronunciation)

## Briefing Structure (Inverted Pyramid - Locked)
0. **Opening** - Short greeting, confirms date/scope
1. **Top Story** - Single most impactful story with full context (Who, What, When, Where, Why)
2. **Hard News** - 2-3 major stories in order of significance
3. **Perspective Split** - When same event is framed differently across regions/outlets
4. **Markets & Tech** - Financial and technology updates
5. **Roundup** - Regional news, sports, lighter items
6. **Kicker** - Memorable closing story
7. **Closing** - Professional sign-off with deep dive prompt

## Project Structure
```
newsy/
├── server.js                    # Express server with API endpoints
├── package.json                 # Dependencies and scripts
├── public/                      # Static files
│   └── index.html               # Main app UI
├── src/
│   └── services/
│       ├── newsService.js       # Fetches news from free APIs
│       ├── anthropic.js         # AI briefing generation (Claude)
│       └── tts.js               # Text-to-speech (OpenAI)
└── replit.md                    # This file
```

## Architecture

### News Flow
1. User selects preferences (topics, regions, publications)
2. `newsService.js` fetches live news from free API (saurav.tech/NewsAPI)
3. `anthropic.js` uses Claude to synthesize articles into a presidential-style briefing
4. Frontend displays briefing with AI-generated audio
5. User can request deep dives on specific topics

### API Endpoints
- `POST /api/briefing` - Generate personalized briefing
- `POST /api/deep-dive` - Generate in-depth analysis on a topic
- `POST /api/tts` - Convert text to speech (returns MP3 audio)
- `GET /api/health` - Health check

### News Sources
Fetches live news via RSS feeds from major sources including:
- Reuters, BBC, Al Jazeera, NPR, The Guardian
- CNBC, Bloomberg, Financial Times
- TechCrunch, Wired, Ars Technica
- South China Morning Post, ESPN, Variety
All feeds are real-time - news is always current

### AI Integration
- Uses Anthropic Claude (claude-sonnet-4-5) for briefing text generation
- Uses ElevenLabs for text-to-speech (consistent, high-quality voices)
- No separate API keys needed - uses Replit AI Integrations (billed to credits)
- Generates professional anchor-style briefings with natural AI voice
- Identifies key topics for deep dive options

## Running the App
```
npm run dev
```

## Environment Variables (Auto-configured)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` - Managed by Replit
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` - Managed by Replit
- ElevenLabs API key - Managed via Replit Connector (for TTS)

## User Preferences
- Never mention user's name in briefings (audio only says greeting without name)
- Professional, neutral, authoritative tone
- No filler words, no adjectives, no urgency language

## Voice Options
- **Gender**: Male (ash) or Female (coral)
- **Accents**: American, British
- Accent is applied via system prompt to guide AI voice delivery

## UI Flow
- **New users**: Welcome screen -> Name/Email -> Publications -> Topics -> Regions -> Voice preferences -> Schedule -> Live Updates -> Done
- **Returning users**: "Hello [name]!" with "Yes, brief me" button + Settings gear icon
- **Settings**: Edit publications, topics, regions, voice preferences, schedule
- **Briefings**: Always show date, time, and timezone at top

## Database
Uses PostgreSQL for persistent storage:
- `push_subscriptions` - Stores web push subscriptions (survives server restarts)
- `user_preferences` - Stores user preferences (topics, regions, voice settings)
- `scheduled_times` - Stores scheduled briefing times per user
- `cached_briefings` - Stores pre-generated briefings and audio
- `live_update_subscriptions` - Stores users subscribed to live breaking news alerts

On server startup, all scheduled notifications are automatically restored from the database using node-cron.

## Scheduling
- Uses `node-cron` for reliable recurring daily schedules (replaced setTimeout)
- Each scheduled briefing creates two cron jobs: pre-generation (1 min before) and notification
- Live update alerts are instant push via `/api/send-live-update` (not scheduled)

## Translation
- Non-English RSS feeds (Arabic, Farsi) are auto-translated via Claude Haiku before briefing
- Translation is batched (all articles translated in one API call)
- Original titles preserved in `originalTitle` field; translated articles tagged with `translated: true`
- State media articles tagged with `stateMedia: true` for attribution

## Live Updates (Automatic Breaking News)
- Background poller checks 10 high-priority ME feeds every 2 minutes
- Uses Claude Haiku to assess if new articles qualify as breaking news
- Automatically sends push notifications to subscribed users
- Tracks seen articles to avoid duplicate alerts (up to 5000 in memory)
- Sources: BBC ME, Al Jazeera, Jerusalem Post, Iran International, Middle East Monitor, The National, Guardian ME, NYT ME, BBC World, Ynet
- Service: `src/services/livePoller.js`
- Status endpoint: `GET /api/live-poller-status`

## User State Persistence
- UUID generated on first visit, stored in a cookie (1 year expiry)
- All user preferences stored server-side in PostgreSQL (source of truth)
- LocalStorage used as a cache for offline/fast loading
- On page load: fetch from server first, fall back to localStorage
- On save: write to both localStorage (cache) and server (source of truth)
- User state survives browser clears, device changes, and private windows (as long as cookie exists)

## Recent Changes
- 2026-03-02: Switched deployment from autoscale to VM (always-on) — required for cron jobs, live poller, and in-memory caches
- 2026-03-02: Fixed timezone handling in scheduled notifications — cron jobs now use user's timezone via node-cron options
- 2026-03-02: Fixed pushUserId not initialized on page load — set in loadState() so cache checks and scheduling work for returning users
- 2026-03-02: On-demand briefings now cached to DB (text + audio) for 15 minutes; both btnListenNow and btnGetBriefing check cache first
- 2026-03-02: Push notification reliability overhaul — setupNotifications always saves push sub, re-subscribes live updates for returning users, silent mode on page load
- 2026-03-02: Added briefing length preference (short/long) — onboarding screen s6b, settings edit, DB column, AI prompt depth guidance, dynamic max_tokens
- 2026-02-28: Moved user state to server-side with UUID cookie (localStorage is now cache only)
- 2026-02-28: Added automatic live news poller with AI-powered breaking news detection
- 2026-02-28: Added Hebrew feeds (Ynet, Walla News) with auto-translation
- 2026-02-28: Added translation layer for non-English feeds (Arabic/Farsi/Hebrew → English via Claude Haiku)
- 2026-02-28: Expanded Middle East sources: Jerusalem Post, Iran International, Guardian ME, NYT ME, Syria Direct, IRNA, Tehran Times, France 24 ME
- 2026-02-28: Added 8-second timeout per feed (prevents slow feeds from blocking entire request)
- 2026-02-28: Removed broken feeds (Al Arabiya, Times of Israel, 972 Mag, Haaretz, Palestine Chronicle - all Cloudflare-blocked)
- 2026-02-28: Replaced setTimeout with node-cron for reliable job scheduling
- 2026-02-28: Added live updates feature (subscribe to breaking news alerts via push)
- 2026-02-28: Added back buttons to all registration steps
- 2026-03-01: Switched TTS to gpt-4o-mini-tts via chat completions (audio.speech not supported by Replit proxy)
- 2026-03-01: Removed Australian/Irish accent options (now American/British only)
- 2026-03-01: Moved live updates opt-in to onboarding flow (removed from briefing screen)
- 2026-03-01: Replaced native time input with select dropdown (avoids iOS Reset button/blue circle)
- 2026-03-01: Added liveUpdatesSubscribed/liveUpdatesDeclined to DB persistence
- 2026-02-28: Improved AI prompt: no asterisks, better transitions, specific deep dive topics
- 2026-02-28: Added logout button in settings
- 2026-02-28: Changed loading text to "Compiling the latest updates"
- 2026-01-27: Added PostgreSQL database for persistent push subscriptions and scheduled times
- 2026-01-27: Notifications now survive server restarts - automatically rescheduled on startup
- 2026-01-27: Fixed notification permission not being requested for returning users
- 2026-01-26: Added countdown timer during briefing generation ("About 2 minutes remaining...")
- 2026-01-26: Improved audio flow: first 3 sections play together, then pause with spoken prompt for Deep Dive or Continue
- 2026-01-26: Added voice command "Deep Dive" to start deep dive analysis after first batch
- 2026-01-26: Fixed microphone permission handling to avoid repeated notifications
- 2026-01-26: Added section-by-section audio playback with voice command navigation (say "Next" to continue)
- 2026-01-26: Implemented Inverted Pyramid journalistic structure (BBC Radio 4 / Reuters style)
- 2026-01-26: Added visual "Next section" button as fallback for browsers without voice support
- 2026-01-26: Added push notifications with custom sci-fi alarm sound at scheduled briefing times
- 2026-01-26: Updated schedule to support 1-4 briefings per day with individual times
- 2026-01-26: Added persistent user profiles - returning users see simplified home screen
- 2026-01-26: Added voice preferences (gender + accent selection)
- 2026-01-26: Added Settings page to edit all preferences
- 2026-01-26: Added timestamp with timezone to all briefings
- 2026-01-26: Added Palestinian news sources (Palestine Chronicle, Quds News Network)
- 2026-01-26: Added diverse global sources (RT, CGTN, Times of India, Middle East Eye, Haaretz, Arab News)
- 2026-01-26: Switched to live RSS feeds for real-time news (was using stale API)
- 2026-01-26: Implemented presidential-style briefing structure (no name, locked format)
- 2026-01-26: Added professional AI voice using OpenAI gpt-audio
- 2026-01-26: Switched to Anthropic Claude via Replit AI Integrations (no API key needed)
- 2026-01-26: Initial project setup with Node.js/Express
