const express = require('express');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const cron = require('node-cron');
const { Pool } = require('pg');
const { fetchNewsForPreferences } = require('./src/services/newsService');
const { generateBriefing, generateBriefingStream, generateDeepDive, generateDeeperDive } = require('./src/services/anthropic');
const { textToSpeech } = require('./src/services/tts');
const { startLivePoller, stopLivePoller, getLivePollerStatus } = require('./src/services/livePoller');

const app = express();
const PORT = process.env.PORT || 3000;

const audioCache = new Map();
const AUDIO_CACHE_TTL = 30 * 60 * 1000;

function getTextHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getCachedAudioByText(text, voice, accent) {
  const key = `${getTextHash(text)}_${voice}_${accent}`;
  const cached = audioCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < AUDIO_CACHE_TTL) {
    return cached.buffer;
  }
  if (cached) audioCache.delete(key);
  return null;
}

function setCachedAudio(text, voice, accent, buffer) {
  const key = `${getTextHash(text)}_${voice}_${accent}`;
  audioCache.set(key, { buffer, timestamp: Date.now() });
  if (audioCache.size > 100) {
    const oldest = [...audioCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 20; i++) audioCache.delete(oldest[i][0]);
  }
}

async function preGenerateFullAudio(fullText, voice, accent) {
  if (!fullText || fullText.length === 0) return;

  // Skip background audio pre-generation entirely if there are no push subscribers.
  if (!(await hasAnyPushSubscribers())) {
    console.log('[AudioPregen] Skipping full TTS – no push subscribers in database');
    return;
  }

  const cleanText = fullText.replace(/\n?DEEP_DIVE_TOPICS:\s*\[.*?\]\s*$/, '').trim();
  const cached = getCachedAudioByText(cleanText, voice, accent);
  if (!cached) {
    console.log(`[AudioPregen] Starting full TTS (${cleanText.length} chars)...`);
    try {
      const buffer = await textToSpeech(cleanText, voice, accent);
      setCachedAudio(cleanText, voice, accent, buffer);
      console.log(`[AudioPregen] Cached full audio (${cleanText.length} chars, ${buffer.length} bytes)`);
    } catch (err) {
      console.error('[AudioPregen] Failed:', err.message);
    }
  }
}

async function preGenerateFullAudioAndCache(cleanText, voice, accent, userId) {
  if (!cleanText || cleanText.length === 0) return;

  // Skip background audio pre-generation entirely if there are no push subscribers.
  if (!(await hasAnyPushSubscribers())) {
    console.log('[AudioPregen] Skipping full TTS cache – no push subscribers in database');
    return;
  }

  const cached = getCachedAudioByText(cleanText, voice, accent);
  if (!cached) {
    console.log(`[AudioPregen] Starting full TTS (${cleanText.length} chars)...`);
    try {
      const buffer = await textToSpeech(cleanText, voice, accent);
      setCachedAudio(cleanText, voice, accent, buffer);
      console.log(`[AudioPregen] Cached full audio (${cleanText.length} chars, ${buffer.length} bytes)`);
      if (userId) {
        try {
          await pool.query(
            `UPDATE cached_briefings SET audio = $1 WHERE user_id = $2`,
            [buffer, userId]
          );
          console.log(`[AudioPregen] Audio saved to DB cache for user: ${userId}`);
        } catch (err) {
          console.error('[AudioPregen] DB audio save failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[AudioPregen] Failed:', err.message);
    }
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Cached flag so we don't constantly hit the database just to learn there are no subscribers.
let hasPushSubscribersCache = {
  value: false,
  lastChecked: 0
};

async function hasAnyPushSubscribers() {
  const now = Date.now();
  // Re-check at most once per minute.
  if (now - hasPushSubscribersCache.lastChecked < 60_000) {
    return hasPushSubscribersCache.value;
  }

  try {
    const result = await pool.query('SELECT 1 FROM push_subscriptions LIMIT 1');
    hasPushSubscribersCache = {
      value: result.rowCount > 0,
      lastChecked: now
    };
    return hasPushSubscribersCache.value;
  } catch (err) {
    console.error('Error checking push subscribers:', err.message);
    hasPushSubscribersCache = { value: false, lastChecked: now };
    return false;
  }
}

pool.on('error', (err) => {
  console.error('Database pool error (non-fatal):', err.message);
});

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:newsy@example.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('Web Push configured');
}

const scheduledCronJobs = new Map();

async function getPushSubscription(userId) {
  try {
    const result = await pool.query('SELECT subscription FROM push_subscriptions WHERE user_id = $1', [userId]);
    let sub = result.rows[0]?.subscription || null;
    if (!sub) return null;

    // Handle legacy rows where subscription was stored as a JSON string
    if (typeof sub === 'string') {
      try {
        sub = JSON.parse(sub);
      } catch (e) {
        console.error('Failed to parse stored push subscription JSON for user:', userId, e.message);
        return null;
      }
    }

    return sub;
  } catch (err) {
    console.error('Error getting push subscription:', err);
    return null;
  }
}

async function savePushSubscription(userId, subscription) {
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription, updated_at) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (user_id) DO UPDATE SET subscription = $2, updated_at = NOW()`,
      [userId, subscription]
    );
    return true;
  } catch (err) {
    console.error('Error saving push subscription:', err);
    return false;
  }
}

async function deletePushSubscription(userId) {
  try {
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
  } catch (err) {
    console.error('Error deleting push subscription:', err);
  }
}

async function getUserPreferences(userId) {
  try {
    const result = await pool.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error getting user preferences:', err);
    return null;
  }
}

async function saveUserPreferences(userId, prefs) {
  try {
    // Ensure topics / regions / publications are plain JSON arrays, not Sets or other objects.
    const toJsonArray = (value, fallback = []) => {
      if (Array.isArray(value)) return value;
      if (value instanceof Set) return Array.from(value);
      if (value && typeof value === 'object' && Symbol.iterator in value) {
        return Array.from(value);
      }
      return fallback;
    };

    const topics = toJsonArray(prefs.topics);
    const regions = toJsonArray(prefs.regions);
    const publications = toJsonArray(prefs.publications);

    await pool.query(
      `INSERT INTO user_preferences (user_id, name, email, topics, regions, publications, voice_gender, voice_accent, briefing_length, briefings_per_day, briefing_times, live_updates_subscribed, live_updates_declined, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (user_id) DO UPDATE SET 
         name = $2, email = $3, topics = $4, regions = $5, publications = $6, 
         voice_gender = $7, voice_accent = $8, briefing_length = $9, briefings_per_day = $10, briefing_times = $11,
         live_updates_subscribed = $12, live_updates_declined = $13, updated_at = NOW()`,
      [
        userId,
        prefs.name,
        prefs.email,
        JSON.stringify(topics),
        JSON.stringify(regions),
        JSON.stringify(publications),
        prefs.voiceGender, prefs.voiceAccent, prefs.briefingLength || 'short', prefs.briefingsPerDay, JSON.stringify(Array.isArray(prefs.briefingTimes) ? prefs.briefingTimes : Object.keys(prefs.briefingTimes || {})),
       prefs.liveUpdatesSubscribed || false, prefs.liveUpdatesDeclined || false]
    );
    return true;
  } catch (err) {
    console.error('Error saving user preferences:', err);
    return false;
  }
}

async function getCachedBriefing(userId) {
  try {
    const result = await pool.query('SELECT briefing, topics, sections, audio, generated_at FROM cached_briefings WHERE user_id = $1', [userId]);
    if (result.rows[0]) {
      const row = result.rows[0];
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      if (new Date(row.generated_at) > fifteenMinutesAgo) {
        return {
          briefing: row.briefing,
          topics: row.topics,
          sections: row.sections,
          audio: row.audio,
          generatedAt: row.generated_at
        };
      }
    }
    return null;
  } catch (err) {
    console.error('Error getting cached briefing:', err);
    return null;
  }
}

async function saveCachedBriefing(userId, briefing, topics, sections, audio) {
  try {
    await pool.query(
      `INSERT INTO cached_briefings (user_id, briefing, topics, sections, audio, generated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET briefing = $2, topics = $3, sections = $4, audio = $5, generated_at = NOW()`,
      [
        userId,
        briefing,
        JSON.stringify(topics || []),
        JSON.stringify(sections || []),
        audio
      ]
    );
    return true;
  } catch (err) {
    console.error('Error saving cached briefing:', err);
    return false;
  }
}

async function getCachedAudio(userId) {
  try {
    const result = await pool.query('SELECT audio, generated_at FROM cached_briefings WHERE user_id = $1', [userId]);
    if (result.rows[0] && result.rows[0].audio) {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      if (new Date(result.rows[0].generated_at) > fifteenMinutesAgo) {
        return result.rows[0].audio;
      }
    }
    return null;
  } catch (err) {
    console.error('Error getting cached audio:', err);
    return null;
  }
}

async function saveScheduledTimes(userId, scheduleTimes, timezone) {
  try {
    await pool.query(
      `INSERT INTO scheduled_times (user_id, schedule_times, timezone, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET schedule_times = $2, timezone = $3, updated_at = NOW()`,
       [userId, JSON.stringify(Array.isArray(scheduleTimes) ? scheduleTimes : Object.keys(scheduleTimes || {})), timezone]
    );
    return true;
  } catch (err) {
    console.error('Error saving scheduled times:', err);
    return false;
  }
}

async function getAllScheduledUsers() {
  try {
    const result = await pool.query(`
      SELECT st.user_id, st.schedule_times, st.timezone, ps.subscription
      FROM scheduled_times st
      LEFT JOIN push_subscriptions ps ON st.user_id = ps.user_id
      WHERE ps.subscription IS NOT NULL
    `);
    return result.rows;
  } catch (err) {
    console.error('Error getting scheduled users:', err);
    return [];
  }
}

async function preGenerateAndNotify(userId) {
  // Only pre-generate audio if this user still has an active push subscription.
  // This prevents burning ElevenLabs credits when there are no subscribers.
  const subscription = await getPushSubscription(userId);
  if (!subscription) {
    console.log('[PreGen] Skipping pre-generation, no push subscription for user:', userId);
    return;
  }

  console.log('Pre-generating briefing for user:', userId);
  const prefs = await getUserPreferences(userId) || { topics: ['Politics/Geopolitics'], regions: ['Global'], publications: [] };

  try {
    const articles = await fetchNewsForPreferences(prefs);
    const result = await generateBriefing(articles, prefs);

    const voice = prefs.voice_gender === 'female' ? 'coral' : 'ash';
    const accent = prefs.voice_accent || 'british';
    const audioBuffer = await textToSpeech(result.briefing, voice, accent);

    await saveCachedBriefing(userId, result.briefing, result.topics, result.sections, audioBuffer);
    console.log('Pre-generated briefing cached for user:', userId);
  } catch (err) {
    console.error('Pre-generation failed for user:', userId, err.message);
  }
}

async function sendBriefingNotification(userId) {
  const subscription = await getPushSubscription(userId);
  if (subscription) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: 'Your Briefing is Ready',
        body: 'Tap to listen to your personalized news briefing',
        tag: 'briefing-reminder',
        requireInteraction: true
      }));
      console.log('Push notification sent to user:', userId);
    } catch (err) {
      console.error('Push notification failed:', err.message);
      if (err.statusCode === 410 || err.statusCode === 404) {
        await deletePushSubscription(userId);
      }
    }
  } else {
    console.log('No push subscription found for user:', userId);
  }
}

function scheduleUserCronJobs(userId, scheduleTimes, timezone) {
  if (scheduledCronJobs.has(userId)) {
    const oldJobs = scheduledCronJobs.get(userId);
    oldJobs.forEach(job => job.stop());
  }

  const jobs = [];
  const cronOptions = {};
  if (timezone) {
    cronOptions.timezone = timezone;
  }

  scheduleTimes.forEach((time, index) => {
    if (!time) return;

    const [hours, minutes] = time.split(':').map(Number);

    let pregenMinutes = minutes - 3;
    let pregenHours = hours;
    if (pregenMinutes < 0) {
      pregenMinutes += 60;
      pregenHours = pregenHours === 0 ? 23 : pregenHours - 1;
    }
    const pregenCron = `${pregenMinutes} ${pregenHours} * * *`;

    const pregenJob = cron.schedule(pregenCron, () => {
      preGenerateAndNotify(userId);
    }, cronOptions);
    jobs.push(pregenJob);

    const notifCron = `${minutes} ${hours} * * *`;
    const notifJob = cron.schedule(notifCron, () => {
      sendBriefingNotification(userId);
    }, cronOptions);
    jobs.push(notifJob);

    console.log(`  Briefing ${index + 1}: pre-gen at ${String(pregenHours).padStart(2,'0')}:${String(pregenMinutes).padStart(2,'0')}, notify at ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')} (${timezone || 'UTC'})`);
  });

  scheduledCronJobs.set(userId, jobs);
}

async function rescheduleAllNotifications() {
  console.log('Rescheduling notifications for all users...');
  const users = await getAllScheduledUsers();

  for (const user of users) {
    const { user_id: userId, schedule_times: scheduleTimes, timezone } = user;
    if (!scheduleTimes || scheduleTimes.length === 0) continue;

    console.log(`Rescheduling for user ${userId}: ${scheduleTimes.join(', ')} (${timezone || 'UTC'})`);
    scheduleUserCronJobs(userId, scheduleTimes, timezone);
  }
  
  console.log(`Rescheduled notifications for ${users.length} users`);
}

app.use(express.json());
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// CSP that allows service workers and push notification subscriptions (worker-src, connect-src)
app.use((req, res, next) => {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "img-src 'self' data: https:",
    "frame-ancestors 'self'",
    "base-uri 'self'"
  ].join("; ");
  res.set("Content-Security-Policy", csp);
  next();
});

let cachedArticles = [];

app.post('/api/briefing', async (req, res) => {
  try {
    const { name, email, topics, regions, outlets } = req.body;
    
    if (!topics || topics.length === 0) {
      return res.status(400).json({ error: 'Please select at least one topic' });
    }
    
    const preferences = {
      name: name || 'there',
      email,
      topics: topics || [],
      regions: regions || ['Global'],
      outlets: outlets || []
    };
    
    console.log('Fetching news for preferences:', JSON.stringify(preferences));
    const fetchStart = Date.now();
    const articles = await fetchNewsForPreferences(preferences);
    console.log(`News fetch complete in ${Date.now() - fetchStart}ms`);
    const uniqueSources = new Set(articles.map(a => a.source)).size;
    console.log(`Fetched ${articles.length} articles from ${uniqueSources} sources`);
    
    // Log topic distribution to verify filtering
    const topicCounts = {};
    articles.forEach(a => {
      topicCounts[a.topic] = (topicCounts[a.topic] || 0) + 1;
    });
    console.log('Article topics:', JSON.stringify(topicCounts));
    console.log('Selected topics:', preferences.topics);
    
    if (articles.length < 5) {
      console.warn('WARNING: Low article count may affect briefing quality');
    }
    
    cachedArticles = articles;
    
    console.log('Generating briefing with Claude...');
    const claudeStart = Date.now();
    const result = await generateBriefing(articles, preferences);
    console.log(`Claude API took ${Date.now() - claudeStart}ms`);
    console.log(`Briefing generated: ${result.sections?.length || 0} sections, ${result.briefing?.length || 0} chars`);
    
    if (result.sections && result.sections.length > 0) {
      result.sections.forEach((s, i) => {
        console.log(`  Section ${i}: ${s.id} (${s.title}) - ${s.text?.length || 0} chars`);
      });
    }
    
    if (result.sections?.length < 3) {
      console.warn('WARNING: Few sections generated, AI may have had issues');
    }
    
    res.json({
      success: true,
      briefing: result.briefing,
      sections: result.sections || [],
      topics: result.topics,
      articleCount: articles.length,
      sourceCount: uniqueSources
    });
  } catch (error) {
    console.error('Briefing error:', error);
    res.status(500).json({ 
      error: 'Failed to generate briefing',
      details: error.message 
    });
  }
});

const recentBriefingsCache = new Map();

app.post('/api/briefing-stream', async (req, res) => {
  try {
    const { name, email, topics, regions, outlets, userId, voice, accent, briefingLength } = req.body;
    
    if (!topics || topics.length === 0) {
      return res.status(400).json({ error: 'Please select at least one topic' });
    }
    
    const preferences = {
      name: name || 'there',
      email,
      topics: topics || [],
      regions: regions || ['Global'],
      outlets: outlets || [],
      briefingLength: briefingLength || 'short'
    };
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);
    
    console.log('Streaming briefing for preferences:', JSON.stringify(preferences));
    const fetchStart = Date.now();
    
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Fetching news...' })}\n\n`);
    
    const articles = await fetchNewsForPreferences(preferences);
    console.log(`News fetch complete in ${Date.now() - fetchStart}ms`);
    
    cachedArticles = articles;
    
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Generating briefing...' })}\n\n`);
    
    const claudeStart = Date.now();
    let fullText = '';
    
    const userKey = userId || email || 'anonymous';
    const cached = recentBriefingsCache.get(userKey);
    const previousBriefing = (cached && (Date.now() - cached.timestamp) < 2 * 60 * 60 * 1000) ? cached.text : null;
    if (previousBriefing) {
      console.log(`Found previous briefing for ${userKey} from ${Math.round((Date.now() - cached.timestamp) / 60000)} min ago`);
    }
    
    for await (const chunk of generateBriefingStream(articles, preferences, previousBriefing)) {
      if (chunk.type === 'text') {
        fullText += chunk.data;
        res.write(`data: ${JSON.stringify({ type: 'text', data: chunk.data })}\n\n`);
      } else if (chunk.type === 'done') {
        console.log(`Claude streaming took ${Date.now() - claudeStart}ms`);
        recentBriefingsCache.set(userKey, { text: fullText, timestamp: Date.now() });

        let deepDiveTopics = [];
        const topicMatch = fullText.match(/DEEP_DIVE_TOPICS:\s*\[(.*?)\]/);
        if (topicMatch) {
          try { deepDiveTopics = JSON.parse(`[${topicMatch[1]}]`); } catch(e) {}
        }

        res.write(`data: ${JSON.stringify({ type: 'done', briefing: fullText, articleCount: articles.length })}\n\n`);
        
        if (userId) {
          const cleanText = fullText.replace(/\n?DEEP_DIVE_TOPICS:\s*\[.*?\]\s*$/, '').trim();
          saveCachedBriefing(userId, cleanText, deepDiveTopics, [], null)
            .then(() => console.log('On-demand briefing cached for user:', userId))
            .catch(err => console.error('Failed to cache on-demand briefing:', err.message));
        }

        if (voice && accent) {
          const cleanTextForAudio = fullText.replace(/\n?DEEP_DIVE_TOPICS:\s*\[.*?\]\s*$/, '').trim();
          preGenerateFullAudioAndCache(cleanTextForAudio, voice, accent, userId);
        }
      } else if (chunk.type === 'error') {
        res.write(`data: ${JSON.stringify({ type: 'error', message: chunk.data })}\n\n`);
      }
    }
    
    clearInterval(keepAlive);
    res.end();
  } catch (error) {
    clearInterval(keepAlive);
    console.error('Streaming briefing error:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      res.end();
    } catch (e) {}
  }
});

app.post('/api/deep-dive', async (req, res) => {
  try {
    const { topics, topic, briefing, preferences } = req.body;
    
    const topicList = topics || (topic ? [topic] : []);
    
    if (!topicList || topicList.length === 0) {
      return res.status(400).json({ error: 'Please select a topic for deep dive' });
    }
    
    console.log('Generating deep dive for:', topicList);
    const articlesToUse = cachedArticles.length > 0 ? cachedArticles : [];
    const deepDive = await generateDeepDive(topicList.join(', '), articlesToUse, preferences || {}, briefing);
    
    res.json({
      success: true,
      deepDive
    });
  } catch (error) {
    console.error('Deep dive error:', error);
    res.status(500).json({ 
      error: 'Failed to generate deep dive',
      details: error.message 
    });
  }
});

app.post('/api/deeper-dive', async (req, res) => {
  try {
    const { topic, previousDive, preferences } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }
    
    console.log('Generating deeper dive for:', topic);
    const deeperDive = await generateDeeperDive(topic, previousDive || '', cachedArticles, preferences || {});
    
    res.json({
      success: true,
      deeperDive
    });
  } catch (error) {
    console.error('Deeper dive error:', error);
    res.status(500).json({ 
      error: 'Failed to generate deeper analysis',
      details: error.message 
    });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'ash', accent = 'american' } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    
    const cached = getCachedAudioByText(text, voice, accent);
    if (cached) {
      console.log('TTS cache hit for text length:', text.length);
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', cached.length);
      return res.send(cached);
    }
    
    console.log('TTS cache miss, generating audio for text length:', text.length, 'voice:', voice, 'accent:', accent);
    const audioBuffer = await textToSpeech(text, voice, accent);
    setCachedAudio(text, voice, accent, audioBuffer);
    
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ 
      error: 'Failed to generate audio',
      details: error.message 
    });
  }
});

app.post('/api/tts-full', async (req, res) => {
  try {
    const { briefingText, voice = 'ash', accent = 'american' } = req.body;
    
    if (!briefingText) {
      return res.status(400).json({ error: 'Briefing text is required' });
    }
    
    console.log('Generating FULL briefing audio, text length:', briefingText.length);
    const audioBuffer = await textToSpeech(briefingText, voice, accent);
    console.log('Full briefing audio generated:', audioBuffer.length, 'bytes');
    
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (error) {
    console.error('Full TTS error:', error);
    res.status(500).json({ 
      error: 'Failed to generate audio',
      details: error.message 
    });
  }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const { userId, name, email, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    await pool.query(
      `INSERT INTO feedback (user_id, name, email, message) VALUES ($1, $2, $3, $4)`,
      [userId || 'anonymous', name || '', email || '', message]
    );
    console.log(`Feedback from ${name || userId}: ${message.substring(0, 100)}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.json({ success: true });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasElevenLabs: !!process.env.ELEVENLABS_API_KEY
  });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

app.post('/api/push-subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body;
    if (!subscription || !userId) {
      return res.status(400).json({ error: 'Subscription and userId required' });
    }
    await savePushSubscription(userId, subscription);
    console.log('Push subscription saved to database for user:', userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Test endpoint to manually trigger a push notification
app.post('/api/test-push', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    
    const subscription = await getPushSubscription(userId);
    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found for user', userId });
    }
    
    console.log('Testing push notification for user:', userId);
    console.log('Subscription endpoint:', subscription.endpoint);
    
    await webpush.sendNotification(subscription, JSON.stringify({
      title: 'Test Notification',
      body: 'Push notifications are working!',
      tag: 'test-notification'
    }));
    
    console.log('Test push notification sent successfully to:', userId);
    res.json({ success: true, message: 'Push notification sent' });
  } catch (error) {
    console.error('Test push failed:', error.message);
    console.error('Error details:', error.statusCode, error.body);
    res.status(500).json({ 
      error: 'Push notification failed', 
      details: error.message,
      statusCode: error.statusCode 
    });
  }
});

app.post('/api/schedule-notifications', async (req, res) => {
  try {
    const { userId, scheduleTimes, timezone, preferences } = req.body;
    if (!userId || !scheduleTimes) {
      return res.status(400).json({ error: 'userId and scheduleTimes required' });
    }

    // Preferences are persisted via /api/user-state. Here we only (re)schedule
    // notification jobs and persist the schedule in scheduled_times.
    scheduleUserCronJobs(userId, scheduleTimes, timezone);
    
    await saveScheduledTimes(userId, scheduleTimes, timezone);
    console.log('Saved scheduled times to database for user:', userId);
    
    res.json({ success: true, scheduledCount: scheduleTimes.filter(t => t).length });
  } catch (error) {
    console.error('Schedule notifications error:', error);
    res.status(500).json({ error: 'Failed to schedule notifications' });
  }
});

app.get('/api/cached-briefing/:userId', async (req, res) => {
  const { userId } = req.params;
  const cached = await getCachedBriefing(userId);
  
  if (!cached) {
    return res.status(404).json({ error: 'No cached briefing available' });
  }
  
  res.json({
    success: true,
    briefing: cached.briefing,
    sections: cached.sections,
    topics: cached.topics,
    generatedAt: cached.generatedAt,
    hasAudio: !!cached.audio
  });
});

app.get('/api/cached-audio/:userId', async (req, res) => {
  const { userId } = req.params;
  const audio = await getCachedAudio(userId);
  
  if (!audio) {
    return res.status(404).json({ error: 'No cached audio available' });
  }
  
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', audio.length);
  res.send(audio);
});

app.post('/api/subscribe-live-updates', async (req, res) => {
  try {
    const { userId, topic } = req.body;
    if (!userId || !topic) {
      return res.status(400).json({ error: 'userId and topic required' });
    }
    await pool.query(
      `INSERT INTO live_update_subscriptions (user_id, topic, subscribed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, topic) DO UPDATE SET subscribed_at = NOW()`,
      [userId, topic]
    );
    console.log('Live update subscription saved:', userId, topic);
    res.json({ success: true });
  } catch (error) {
    console.error('Live update subscribe error:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

app.post('/api/send-live-update', async (req, res) => {
  try {
    const { topic, title, body } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required' });
    }
    
    const topicFilter = topic || 'middle-east-tensions';
    const subscribers = await pool.query(
      `SELECT DISTINCT lus.user_id, ps.subscription
       FROM live_update_subscriptions lus
       JOIN push_subscriptions ps ON lus.user_id = ps.user_id
       WHERE lus.topic = $1`,
      [topicFilter]
    );
    
    let sent = 0;
    let failed = 0;
    for (const row of subscribers.rows) {
      try {
        const sub = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
        await webpush.sendNotification(sub, JSON.stringify({
          title: title,
          body: body,
          tag: 'live-update-' + Date.now(),
          requireInteraction: true
        }));
        sent++;
      } catch (err) {
        console.error('Live update push failed for', row.user_id, err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          await deletePushSubscription(row.user_id);
        }
        failed++;
      }
    }
    
    console.log(`Live update sent: ${sent} success, ${failed} failed`);
    res.json({ success: true, sent, failed, total: subscribers.rows.length });
  } catch (error) {
    console.error('Send live update error:', error);
    res.status(500).json({ error: 'Failed to send live update' });
  }
});

app.get('/api/user-state/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const prefs = await getUserPreferences(uuid);
    if (!prefs) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      success: true,
      state: {
        name: prefs.name || '',
        email: prefs.email || '',
        topics: prefs.topics || [],
        regions: prefs.regions || [],
        outlets: prefs.publications || [],
        voiceGender: prefs.voice_gender || 'male',
        voiceAccent: prefs.voice_accent || 'british',
        briefingLength: prefs.briefing_length || 'short',
        briefingsPerDay: prefs.briefings_per_day || 1,
        briefingTimes: prefs.briefing_times || ['08:00'],
        isRegistered: true,
        liveUpdatesSubscribed: prefs.live_updates_subscribed || false,
        liveUpdatesDeclined: prefs.live_updates_declined || false
      }
    });
  } catch (err) {
    console.error('Get user state error:', err);
    res.status(500).json({ error: 'Failed to load user state' });
  }
});

// Look up or create a user profile based on email.
// If the email already exists, return that user's ID and full preferences so onboarding can be skipped.
// If it doesn't, return a new or existing userId to use for this email going forward.
app.post('/api/user-lookup-or-create', async (req, res) => {
  try {
    const { email, name, currentId } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Try to find an existing preferences row for this email (most recent if duplicates exist)
    const existing = await pool.query(
      `SELECT user_id FROM user_preferences WHERE email = $1 ORDER BY updated_at DESC LIMIT 1`,
      [email]
    );

    if (existing.rows[0]) {
      const userId = existing.rows[0].user_id;
      const prefs = await getUserPreferences(userId);
      if (!prefs) {
        // Should be rare – row was deleted between queries
        return res.json({ found: false, userId });
      }

      return res.json({
        found: true,
        userId,
        state: {
          name: prefs.name || name || '',
          email: prefs.email || email,
          topics: prefs.topics || [],
          regions: prefs.regions || [],
          outlets: prefs.publications || [],
          voiceGender: prefs.voice_gender || 'male',
          voiceAccent: prefs.voice_accent || 'british',
          briefingLength: prefs.briefing_length || 'short',
          briefingsPerDay: prefs.briefings_per_day || 1,
          briefingTimes: prefs.briefing_times || ['08:00'],
          isRegistered: true,
          liveUpdatesSubscribed: prefs.live_updates_subscribed || false,
          liveUpdatesDeclined: prefs.live_updates_declined || false
        }
      });
    }

    // New email – use the caller's currentId (UUID cookie) if provided,
    // otherwise generate a fresh UUID on the server.
    const userId = currentId || crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (user_id, email, name, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, email, name || '']
    );
    return res.json({ found: false, userId });
  } catch (err) {
    console.error('User lookup/create error:', err);
    res.status(500).json({ error: 'Failed to look up or create user' });
  }
});

app.put('/api/user-state/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;
    const s = req.body;

    const toArray = (v) => {
      // If it's already an array, keep as is
      if (Array.isArray(v)) return v;

      // If it's a Set (defensive, though Sets don't survive JSON transport)
      if (v instanceof Set) return Array.from(v);

      // If it's a JSON string, try to parse into an array
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed;
        } catch (_) {
          // fall through to object-keys fallback below
        }
      }

      // If it's an object, use keys as a last-resort array representation
      if (v && typeof v === 'object') {
        return Object.keys(v);
      }

      return [];
    };

    const topics = toArray(s.topics);
    const regions = toArray(s.regions);
    const outlets = toArray(s.outlets);

    await saveUserPreferences(uuid, {
      name: s.name || '',
      email: s.email || '',
      topics,
      regions,
      publications: outlets,
      voiceGender: s.voiceGender || 'male',
      voiceAccent: s.voiceAccent || 'british',
      briefingLength: s.briefingLength || 'short',
      briefingsPerDay: s.briefingsPerDay || 1,
      briefingTimes: s.briefingTimes || ['08:00'],
      liveUpdatesSubscribed: s.liveUpdatesSubscribed || false,
      liveUpdatesDeclined: s.liveUpdatesDeclined || false
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Save user state error:', err);
    res.status(500).json({ error: 'Failed to save user state' });
  }
});

app.get('/api/generate-uuid', (req, res) => {
  res.json({ uuid: crypto.randomUUID() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function sendLiveUpdateToSubscribers({ title, body, topic }) {
  try {
    const topicFilter = topic || 'middle-east-tensions';
    const subscribers = await pool.query(
      `SELECT DISTINCT lus.user_id, ps.subscription
       FROM live_update_subscriptions lus
       JOIN push_subscriptions ps ON lus.user_id = ps.user_id
       WHERE lus.topic = $1`,
      [topicFilter]
    );

    let sent = 0;
    for (const row of subscribers.rows) {
      try {
        const sub = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
        await webpush.sendNotification(sub, JSON.stringify({
          title,
          body,
          tag: 'live-update-' + Date.now(),
          requireInteraction: true
        }));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await deletePushSubscription(row.user_id);
        }
      }
    }
    if (sent > 0) {
      console.log(`[LiveUpdate] Sent to ${sent}/${subscribers.rows.length} subscribers: ${title}`);
    }
  } catch (err) {
    console.error('[LiveUpdate] Send error:', err.message);
  }
}

app.get('/api/live-poller-status', (req, res) => {
  res.json(getLivePollerStatus());
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Newsy server running on port ${PORT}`);
  console.log(`Anthropic AI configured: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`ElevenLabs TTS configured: ${!!process.env.ELEVENLABS_API_KEY}`);
  console.log(`Database connected: ${!!process.env.DATABASE_URL}`);

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE, push_subscription JSONB, preferences JSONB, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS briefings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), content TEXT, audio_url TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_times (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), schedule_times JSONB, timezone TEXT, updated_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), UNIQUE (user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_update_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), topic TEXT, subscribed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(), UNIQUE (user_id, topic))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), subscription JSONB, updated_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
    console.log('Database tables ready');
  } catch (e) {
    console.error('Table creation error:', e.message);
  }

  await rescheduleAllNotifications();

  startLivePoller(sendLiveUpdateToSubscribers);
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  stopLivePoller();
  server.close(() => {
    console.log('Server closed.');
    pool.end(() => {
      console.log('Database pool closed.');
      process.exit(0);
    });
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server staying alive):', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server staying alive):', reason);
});


