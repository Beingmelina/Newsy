const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const parser = new Parser();

let cachedNews = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000;

let translationClient = null;
function getTranslationClient() {
  if (!translationClient) {
    translationClient = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return translationClient;
}

const RSS_FEEDS = {
  'Politics/Geopolitics': [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'Global' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', region: 'Middle East' },
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', region: 'US/Canada' },
    { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', region: 'Europe' },
    { name: 'RT News (Russia)', url: 'https://www.rt.com/rss/news/', region: 'Global' },
    { name: 'The National (UAE)', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml', region: 'Middle East' },
    { name: 'Middle East Monitor', url: 'https://www.middleeastmonitor.com/feed/', region: 'Middle East' },
    { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx', region: 'Middle East' },
    { name: 'Iran International', url: 'https://www.iranintl.com/en/feed', region: 'Middle East' },
    { name: 'NYT Middle East', url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml', region: 'Middle East' },
    { name: 'Guardian Middle East', url: 'https://www.theguardian.com/world/middleeast/rss', region: 'Middle East' },

    { name: 'France 24 Arabic', url: 'https://www.france24.com/ar/rss', region: 'Middle East', lang: 'ar' },
    { name: 'France 24 ME', url: 'https://www.france24.com/en/middle-east/rss', region: 'Middle East' },
    { name: 'Iran International (Farsi)', url: 'https://www.iranintl.com/fa/feed', region: 'Middle East', lang: 'fa' },
    { name: 'Ynet (Hebrew)', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', region: 'Middle East', lang: 'he' },
    { name: 'Walla News (Hebrew)', url: 'https://rss.walla.co.il/feed/1', region: 'Middle East', lang: 'he' },
    { name: 'International Crisis Group', url: 'https://www.crisisgroup.org/rss.xml', region: 'Middle East' },
    { name: 'Iraqi News', url: 'https://www.iraqinews.com/feed/', region: 'Middle East' },
    { name: 'Al Monitor', url: 'https://www.al-monitor.com/rss', region: 'Middle East' },
  ],
  'Business/Markets': [
    { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', region: 'Global' },
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', region: 'US/Canada' },
    { name: 'Financial Times', url: 'https://www.ft.com/rss/home', region: 'Global' },
    { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss', region: 'Global' },
    { name: 'WSJ Markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', region: 'Global' },
    { name: 'WSJ Business', url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness', region: 'Global' },
    { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar', region: 'Global' },
    { name: 'SCMP', url: 'https://www.scmp.com/rss/91/feed', region: 'Global' },
    { name: 'The Economist Finance', url: 'https://www.economist.com/finance-and-economics/rss.xml', region: 'Global' },
    { name: 'The Economist Business', url: 'https://www.economist.com/business/rss.xml', region: 'Global' },
  ],
  'Tech/AI': [
    { name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', region: 'Global' },
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', region: 'Global' },
    { name: 'Wired', url: 'https://www.wired.com/feed/rss', region: 'Global' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', region: 'Global' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', region: 'Global' },
    { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed', region: 'Global' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/', region: 'Global' },
    { name: 'Rest of World', url: 'https://restofworld.org/feed/latest/', region: 'Global' },
  ],
  'Health/Longevity': [
    { name: 'BBC Health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', region: 'Global' },
    { name: 'NPR Health', url: 'https://feeds.npr.org/103537970/rss.xml', region: 'US/Canada' },
    { name: 'STAT News', url: 'https://www.statnews.com/feed/', region: 'Global' },
    { name: 'Guardian Health', url: 'https://www.theguardian.com/society/health/rss', region: 'Global' },
  ],
  'Arts/Culture': [
    { name: 'BBC Entertainment', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', region: 'Global' },
    { name: 'NPR Arts', url: 'https://feeds.npr.org/1008/rss.xml', region: 'US/Canada' },
    { name: 'The Guardian Culture', url: 'https://www.theguardian.com/culture/rss', region: 'Europe' },
    { name: 'The Atlantic', url: 'https://www.theatlantic.com/feed/all/', region: 'Global' },
    { name: 'The Economist Culture', url: 'https://www.economist.com/culture/rss.xml', region: 'Global' },
    { name: 'Pitchfork', url: 'https://pitchfork.com/feed/rss', region: 'Global' },
  ],
  'Sports': [
    { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', region: 'Global' },
    { name: 'ESPN', url: 'https://www.espn.com/espn/rss/news', region: 'US/Canada' },
    { name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040', region: 'Global' },
  ],
  'Entertainment': [
    { name: 'BBC Entertainment', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', region: 'Global' },
    { name: 'Variety', url: 'https://variety.com/feed/', region: 'Global' },
    { name: 'Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/', region: 'Global' },
    { name: 'Deadline', url: 'https://deadline.com/feed/', region: 'Global' },
  ]
};

const REGION_FEEDS = {
  'Middle East': [
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
    { name: 'The National (UAE)', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml' },
    { name: 'Middle East Monitor', url: 'https://www.middleeastmonitor.com/feed/' },
    { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx' },
    { name: 'Iran International', url: 'https://www.iranintl.com/en/feed' },
    { name: 'Guardian Middle East', url: 'https://www.theguardian.com/world/middleeast/rss' },
    { name: 'NYT Middle East', url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml' },
    { name: 'France 24 Arabic', url: 'https://www.france24.com/ar/rss', lang: 'ar' },
    { name: 'France 24 ME', url: 'https://www.france24.com/en/middle-east/rss' },
    { name: 'Iran International (Farsi)', url: 'https://www.iranintl.com/fa/feed', lang: 'fa' },
    { name: 'Ynet (Hebrew)', url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', lang: 'he' },
    { name: 'Walla News (Hebrew)', url: 'https://rss.walla.co.il/feed/1', lang: 'he' },
    { name: 'International Crisis Group', url: 'https://www.crisisgroup.org/rss.xml' },
    { name: 'Iraqi News', url: 'https://www.iraqinews.com/feed/' },
  ],
  'Europe': [
    { name: 'BBC Europe', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml' },
    { name: 'The Guardian Europe', url: 'https://www.theguardian.com/world/europe-news/rss' },
    { name: 'RT News (Russia)', url: 'https://www.rt.com/rss/news/' },
  ],
  'US/Canada': [
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'BBC North America', url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml' },
  ],
  'Asia': [
    { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
    { name: 'South China Morning Post', url: 'https://www.scmp.com/rss/91/feed' },
  ],
  'Global': [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'RT News (Russia)', url: 'https://www.rt.com/rss/news/' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  ]
};

async function translateArticles(articles) {
  if (articles.length === 0) return [];

  const textsToTranslate = articles.map((a, i) =>
    `[${i}] TITLE: ${a.title}\nDESC: ${a.description?.substring(0, 400) || ''}`
  ).join('\n\n');

  try {
    const client = getTranslationClient();
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Translate the following news headlines and descriptions to English. Keep the [index] numbering. Output ONLY the translations, one per line in format: [index] TITLE: translated title | DESC: translated description\n\n${textsToTranslate}`
      }],
      system: 'You are a professional news translator. Translate accurately and concisely. Preserve meaning and tone. Output only translations.'
    });

    const responseText = message.content[0].text;
    const lines = responseText.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const match = line.match(/\[(\d+)\]\s*TITLE:\s*(.*?)\s*\|\s*DESC:\s*(.*)/);
      if (match) {
        const idx = parseInt(match[1]);
        if (idx < articles.length) {
          articles[idx].originalTitle = articles[idx].title;
          articles[idx].title = match[2].trim();
          articles[idx].description = match[3].trim();
          articles[idx].translated = true;
        }
      }
    }

    console.log(`Translated ${articles.filter(a => a.translated).length}/${articles.length} articles`);
  } catch (err) {
    console.error('Translation failed:', err.message);
  }

  return articles;
}

function timeoutPromise(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms));
}

async function fetchFeed(feedInfo, topic) {
  try {
    const feed = await Promise.race([
      parser.parseURL(feedInfo.url),
      timeoutPromise(8000)
    ]);
    return feed.items.slice(0, 5).map(item => ({
      title: item.title || '',
      description: item.contentSnippet || item.content || item.description || '',
      content: item.content || item.contentSnippet || item.description || '',
      source: feedInfo.name,
      url: item.link || '',
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      topic: topic,
      region: feedInfo.region || 'Global',
      lang: feedInfo.lang || 'en',
      stateMedia: feedInfo.stateMedia || false
    }));
  } catch (error) {
    console.error(`Error fetching feed ${feedInfo.name}:`, error.message);
    return [];
  }
}

async function fetchNewsForPreferences(preferences, forceRefresh = false) {
  const startTime = Date.now();
  const { topics, regions } = preferences;
  
  const cacheKey = JSON.stringify({ topics: topics.sort(), regions: regions.sort() });
  
  if (!forceRefresh && cachedNews && cachedNews.key === cacheKey && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    console.log('Using cached news (age: ' + Math.round((Date.now() - cacheTimestamp) / 1000) + 's)');
    return cachedNews.articles;
  }
  
  const allArticles = [];
  const seenUrls = new Set();
  const feedPromises = [];
  
  for (const topic of topics) {
    const topicFeeds = RSS_FEEDS[topic] || RSS_FEEDS['Politics/Geopolitics'];
    
    for (const feed of topicFeeds) {
      if (regions.includes(feed.region) || regions.includes('Global') || feed.region === 'Global') {
        feedPromises.push(fetchFeed(feed, topic));
      }
    }
  }
  
  for (const region of regions) {
    const regionFeeds = REGION_FEEDS[region] || [];
    for (const feed of regionFeeds) {
      feedPromises.push(fetchFeed({ ...feed, region }, 'Politics/Geopolitics'));
    }
  }
  
  console.log(`Fetching ${feedPromises.length} feeds in parallel...`);
  const results = await Promise.all(feedPromises);
  console.log(`RSS fetching took ${Date.now() - startTime}ms`);
  
  const nonEnglishArticles = [];

  for (const articles of results) {
    for (const article of articles) {
      if (!seenUrls.has(article.url) && article.title && article.description) {
        seenUrls.add(article.url);
        if (article.lang && article.lang !== 'en') {
          nonEnglishArticles.push(article);
        } else {
          allArticles.push(article);
        }
      }
    }
  }

  if (nonEnglishArticles.length > 0) {
    const translateStart = Date.now();
    const translated = await translateArticles(nonEnglishArticles);
    console.log(`Translation took ${Date.now() - translateStart}ms for ${nonEnglishArticles.length} articles`);
    allArticles.push(...translated);
  }
  
  allArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  
  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => new Date(a.publishedAt) > oneDayAgo);
  
  const finalArticles = recentArticles.length > 0 ? recentArticles.slice(0, 30) : allArticles.slice(0, 30);
  
  cachedNews = { key: cacheKey, articles: finalArticles };
  cacheTimestamp = Date.now();
  console.log(`Total: ${finalArticles.length} articles (${finalArticles.filter(a => a.translated).length} translated), cached for 5 minutes`);
  
  return finalArticles;
}

module.exports = {
  fetchNewsForPreferences,
  RSS_FEEDS,
  REGION_FEEDS
};
