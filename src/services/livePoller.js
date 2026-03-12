const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');

const parser = new Parser();
const seenArticles = new Set();
const sentAlertEvents = new Map();
const SENT_ALERT_TTL = 24 * 60 * 60 * 1000;
let isRunning = false;
let pollInterval = null;

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const MAX_SEEN_SIZE = 5000;

const LIVE_FEEDS = [
  { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', lang: 'en', type: 'wire' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en', type: 'wire' },
  { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx', lang: 'en', type: 'regional', noAlerts: true },
  { name: 'Iran International', url: 'https://www.iranintl.com/en/feed', lang: 'en', type: 'regional' },
  { name: 'IRNA (Iran State)', url: 'https://en.irna.ir/rss', lang: 'en', type: 'state' },
  { name: 'Tasnim News', url: 'https://www.tasnimnews.com/en/rss', lang: 'en', type: 'state' },
  { name: 'Fars News', url: 'https://www.farsnews.ir/rss', lang: 'en', type: 'state' },
  { name: 'PressTV', url: 'https://www.presstv.ir/rss', lang: 'en', type: 'state' },
  { name: 'Middle East Monitor', url: 'https://www.middleeastmonitor.com/feed/', lang: 'en', type: 'regional' },
  { name: 'The National (UAE)', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', lang: 'en', type: 'state' },
  { name: 'Guardian Middle East', url: 'https://www.theguardian.com/world/middleeast/rss', lang: 'en', type: 'wire' },
  { name: 'NYT Middle East', url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml', lang: 'en', type: 'wire' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en', type: 'wire' },
  { name: 'Ynet (Hebrew)', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', lang: 'he', type: 'regional', noAlerts: true },
  { name: 'International Crisis Group', url: 'https://www.crisisgroup.org/rss.xml', lang: 'en', type: 'wire' },
  { name: 'Iraqi News', url: 'https://www.iraqinews.com/feed/', lang: 'en', type: 'regional' },
];

function timeoutPromise(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function fetchFeedArticles(feed) {
  try {
    const result = await Promise.race([
      parser.parseURL(feed.url),
      timeoutPromise(8000)
    ]);
    return result.items.slice(0, 3).map(item => ({
      title: item.title || '',
      description: item.contentSnippet || item.content || item.description || '',
      source: feed.name,
      sourceType: feed.type,
      url: item.link || '',
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      lang: feed.lang,
      noAlerts: feed.noAlerts || false
    }));
  } catch (err) {
    return [];
  }
}

async function translateTitle(title, lang) {
  try {
    const client = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Translate this ${lang === 'he' ? 'Hebrew' : 'Arabic'} news headline to English. Output ONLY the translation:\n${title}` }],
    });
    return msg.content[0].text.trim();
  } catch (err) {
    return title;
  }
}

async function assessBreakingNews(articles) {
  if (articles.length === 0) return { tierA: [], tierB: [] };

  const headlines = articles.map((a, i) => 
    `[${i}] [${a.sourceType?.toUpperCase() || 'REGIONAL'}] ${a.source}: ${a.title}`
  ).join('\n');

  try {
    const client = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a breaking news editor for a Middle East-focused news service for business professionals. Classify these headlines into two tiers.

SOURCE TYPES (shown in brackets):
- WIRE = global wire services (BBC, Guardian, NYT, Al Jazeera, ICG) — high credibility
- STATE = official state media (The National/UAE, WAM) — official but may have bias
- REGIONAL = regional outlets (Jerusalem Post, Iran International, Ynet, Iraqi News, Middle East Monitor) — may have partisan framing

TIER A — IMMEDIATE PUSH ALERT:
Events that would make a news channel interrupt programming:
- Major military escalation: missile strikes, airstrikes, military retaliation
- Death or assassination of a significant leader
- Airspace closures or major military mobilization
- Ceasefire announcements or peace deal breakthroughs
- Official government warnings to citizens (e.g., UAE ministry alerts)
- Major oil supply disruption or market crash tied to geopolitical event
- Large-scale humanitarian disaster

VERIFICATION RULES FOR TIER A:
- Requires 2+ sources reporting the same event (1 wire + 1 other preferred)
- EXCEPTION: If the event is enormous (e.g., death of a supreme leader, nuclear strike), even 1 source is enough — but mark as "DEVELOPING"
- If only 1 partisan/regional outlet reports it with no wire confirmation, mark as "UNCONFIRMED"

TIER B — INCLUDE IN NEXT BRIEFING ONLY (no push):
- Political statements, diplomatic positioning
- Troop movements without active engagement
- Sanctions announcements
- Routine diplomatic meetings
- Analysis or opinion pieces
- Updates on ongoing situations with no major new development
- Stories more than 6 hours old
- Sports, entertainment, culture

Headlines:
${headlines}

Reply in this EXACT format:
TIER_A: [comma-separated indices] or NONE
TIER_A_STATUS: [for each Tier A index, one of: CONFIRMED, DEVELOPING, UNCONFIRMED]
TIER_B: [comma-separated indices] or NONE

Example: 
TIER_A: 2, 5
TIER_A_STATUS: CONFIRMED, DEVELOPING
TIER_B: 1, 7`
      }],
    });

    const response = msg.content[0].text.trim();
    console.log('[LivePoller] AI assessment:', response);
    
    const tierAMatch = response.match(/TIER_A:\s*(.+)/);
    const tierAStatusMatch = response.match(/TIER_A_STATUS:\s*(.+)/);
    const tierBMatch = response.match(/TIER_B:\s*(.+)/);
    
    const tierA = [];
    if (tierAMatch && tierAMatch[1].trim() !== 'NONE') {
      const indices = tierAMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const statuses = tierAStatusMatch 
        ? tierAStatusMatch[1].split(',').map(s => s.trim().toUpperCase()) 
        : [];
      
      for (let j = 0; j < indices.length; j++) {
        const i = indices[j];
        if (i >= 0 && i < articles.length) {
          const status = statuses[j] || 'UNCONFIRMED';
          tierA.push({ ...articles[i], verificationStatus: status });
        }
      }
    }
    
    const tierB = [];
    if (tierBMatch && tierBMatch[1].trim() !== 'NONE') {
      const indices = tierBMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      for (const i of indices) {
        if (i >= 0 && i < articles.length) tierB.push(articles[i]);
      }
    }
    
    return { tierA, tierB };
  } catch (err) {
    console.error('Breaking news assessment failed:', err.message);
    return { tierA: [], tierB: [] };
  }
}

function generateArticleId(article) {
  return `${article.source}:${article.url || article.title}`;
}

function isDuplicateEvent(newTitle) {
  const now = Date.now();
  for (const [sentTitle, sentTime] of sentAlertEvents.entries()) {
    if (now - sentTime > SENT_ALERT_TTL) {
      sentAlertEvents.delete(sentTitle);
      continue;
    }
    const newWords = newTitle.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const sentWords = sentTitle.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const overlap = newWords.filter(w => sentWords.includes(w)).length;
    const similarity = overlap / Math.max(newWords.length, sentWords.length);
    if (similarity >= 0.7) return true;
  }
  return false;
}

function pruneSeenArticles() {
  if (seenArticles.size > MAX_SEEN_SIZE) {
    const entries = Array.from(seenArticles);
    const toRemove = entries.slice(0, entries.length - MAX_SEEN_SIZE + 1000);
    toRemove.forEach(e => seenArticles.delete(e));
  }
}

async function pollForBreakingNews(sendNotificationCallback) {
  const pollStart = Date.now();

  const results = await Promise.all(LIVE_FEEDS.map(f => fetchFeedArticles(f)));
  const allArticles = results.flat();

  const newArticles = allArticles.filter(a => {
    const id = generateArticleId(a);
    if (seenArticles.has(id)) return false;
    seenArticles.add(id);
    return true;
  });

  pruneSeenArticles();

  if (newArticles.length === 0) {
    return;
  }

  const nonEnglish = newArticles.filter(a => a.lang && a.lang !== 'en');
  for (const article of nonEnglish) {
    article.title = await translateTitle(article.title, article.lang);
  }

  const alertEligible = newArticles.filter(a => !a.noAlerts);
  const briefingOnly = newArticles.filter(a => a.noAlerts);
  const { tierA, tierB } = await assessBreakingNews(alertEligible);
  const allTierB = [...tierB, ...briefingOnly];

  if (tierA.length > 0) {
    console.log(`[LivePoller] ${tierA.length} TIER A alerts detected:`);
    for (const article of tierA) {
      const status = article.verificationStatus;
      let prefix = 'Breaking';
      if (status === 'DEVELOPING') prefix = 'Developing';
      if (status === 'UNCONFIRMED') prefix = 'Unconfirmed';
      
      let body = `Via ${article.source}`;
      if (status === 'DEVELOPING') body = `Developing story. Via ${article.source}`;
if (status === 'UNCONFIRMED') body = `Via ${article.source}`;
      
      console.log(`  - [${status}] ${article.source}: ${article.title}`);
      if (isDuplicateEvent(article.title)) {
        console.log(`  - [SKIPPED - duplicate event] ${article.source}: ${article.title}`);
        continue;
      }
      sentAlertEvents.set(article.title, Date.now());
      try {
        await sendNotificationCallback({
          title: `${prefix}: ${article.title}`,
          body: body,
          topic: 'middle-east-tensions',
          url: article.url || ''
        });
      } catch (err) {
        console.error('[LivePoller] Failed to send notification:', err.message);
      }
    }
  }

  if (allTierB.length > 0) {
    console.log(`[LivePoller] ${allTierB.length} Tier B stories (for next briefing):`);
    for (const article of allTierB) {
      console.log(`  - ${article.source}: ${article.title}`);
    }
  }

  const elapsed = Date.now() - pollStart;
  console.log(`[LivePoller] Poll complete: ${allArticles.length} articles, ${newArticles.length} new, ${tierA.length} Tier A, ${tierB.length} Tier B (${elapsed}ms)`);
}

async function startLivePoller(sendNotificationCallback, pool) {
  if (isRunning) {
    console.log('[LivePoller] Already running');
    return;
  }

  if (pool) {
    try {
      const recent = await pool.query(
        `SELECT title, source FROM live_alerts WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      for (const row of recent.rows) {
        const id = `${row.source}:${row.title}`;
        seenArticles.add(id);
        sentAlertEvents.set(row.title, Date.now());
      }
      console.log(`[LivePoller] Pre-loaded ${recent.rows.length} recent alerts from DB`);
    } catch (err) {
      console.error('[LivePoller] Failed to pre-load seen articles:', err.message);
    }
  }

  console.log(`[LivePoller] Starting (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  isRunning = true;

  pollForBreakingNews(sendNotificationCallback).catch(err => {
    console.error('[LivePoller] Initial poll error:', err.message);
  });

  pollInterval = setInterval(() => {
    pollForBreakingNews(sendNotificationCallback).catch(err => {
      console.error('[LivePoller] Poll error:', err.message);
    });
  }, POLL_INTERVAL_MS);
}

function stopLivePoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isRunning = false;
  console.log('[LivePoller] Stopped');
}

function getLivePollerStatus() {
  return {
    running: isRunning,
    seenCount: seenArticles.size,
    feedCount: LIVE_FEEDS.length,
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000
  };
}

module.exports = {
  startLivePoller,
  stopLivePoller,
  getLivePollerStatus,
  LIVE_FEEDS
};
