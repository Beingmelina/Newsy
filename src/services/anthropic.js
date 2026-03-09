const Anthropic = require('@anthropic-ai/sdk');

let anthropic = null;

function getAnthropicClient() {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return anthropic;
}

function parseJsonResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return JSON.parse(cleaned.trim());
}

const recentBriefings = new Map();

async function* generateBriefingStream(articles, preferences, previousBriefing) {
  if (!articles || articles.length === 0) {
    yield { type: 'error', data: 'No articles available' };
    return;
  }
  
  // Filter articles to ONLY include those matching selected topics
  const selectedTopicsList = preferences.topics || [];
  const filteredArticles = articles.filter(article => {
    if (article.topic && selectedTopicsList.includes(article.topic)) {
      return true;
    }
    return false;
  });
  
  const articlesToUse = filteredArticles.length > 0 ? filteredArticles : articles;
  
  const articleSummaries = articlesToUse.map((a, i) => 
    `[${i + 1}] [TOPIC: ${a.topic}] ${a.source}: "${a.title}" - ${a.description}`
  ).join('\n\n');
  
  const currentHour = new Date().getHours();
  const greeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-US', { 
    weekday: 'long', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'UTC'
  }).format(now);
  
  const selectedTopics = selectedTopicsList.join(', ') || 'General news';
  const selectedRegions = preferences.regions?.join(', ') || 'Global';
  
  // Build dynamic section list based on selected topics
  const sectionList = ['Opening'];
  if (selectedTopicsList.includes('Politics/Geopolitics')) {
    sectionList.push('Top Global News', 'Secondary international developments', 'Domestic/regional news');
  }
  if (selectedTopicsList.includes('Business/Markets')) {
    sectionList.push('Business & markets');
  }
  if (selectedTopicsList.includes('Tech/AI') || selectedTopicsList.includes('Health/Longevity')) {
    sectionList.push('Science/health/tech');
  }
  if (selectedTopicsList.includes('Arts/Culture') || selectedTopicsList.includes('Entertainment')) {
    sectionList.push('Art/culture');
  }
  if (selectedTopicsList.includes('Sports')) {
    sectionList.push('Sports');
  }
  sectionList.push('Closing');
  
  let previousBriefingSection = '';
  if (previousBriefing) {
    previousBriefingSection = `
PREVIOUS BRIEFING (the user heard this recently - DO NOT repeat the same stories or framing):
---
${previousBriefing.substring(0, 2000)}
---
Since the user already heard the above briefing, you MUST:
- Focus on NEW developments, updates, or angles not covered before
- If a story was already covered, only mention it if there are genuine new developments - and say "Since our last briefing..." or "Updating our earlier report..."
- Go deeper on stories that were only briefly mentioned before
- Introduce stories that were not in the previous briefing
- Do NOT repeat the same information or framing
`;
  }

  const lengthPref = preferences.briefingLength || 'short';
  const topicCount = selectedTopicsList.length;

  let longGuide;
  if (topicCount <= 2) {
    longGuide = `FULL BRIEFING (1000-1300 words, 5-7 minutes read aloud).
DEPTH RULES (${topicCount} topics selected — go deep):
- For each selected topic, provide full coverage: what happened, context, why it matters, and what comes next.
- Include how different sources frame the same story (perspective splits). Show where outlets agree and disagree.
- Cover secondary developments and regional angles within each topic.
- Include detailed source attribution throughout — the listener must know WHO is saying WHAT.
- Routine updates and lighter stories within selected topics are welcome if space allows.`;
  } else if (topicCount <= 4) {
    longGuide = `FULL BRIEFING (1000-1300 words, 5-7 minutes read aloud).
DEPTH RULES (${topicCount} topics selected — moderate depth):
- For each selected topic, cover the main stories with context and why they matter. More depth than a headline, but be selective.
- Include perspective splits only for the most significant stories (1-2 per topic at most).
- Cover secondary developments briefly — one sentence each if relevant.
- Include source attribution for key claims. The listener must know WHO is saying WHAT on contested stories.
- Skip lighter or routine updates to keep the pace moving.`;
  } else {
    longGuide = `FULL BRIEFING (1000-1300 words, 5-7 minutes read aloud).
DEPTH RULES (${topicCount} topics selected — breadth over depth):
- You have many topics to cover. Give each topic 2-4 sentences: what happened, why it matters, and one key source attribution.
- Include a perspective split only for the single biggest story of the day.
- Do NOT go into secondary developments or regional angles — there is no room. Stay focused on the lead story per topic.
- Still more informative than a headline-only briefing: include context and "what comes next" where possible.
- Move briskly between topics with clear transitions.`;
  }

  const lengthGuide = {
    short: `SHORT BRIEFING (600-900 words, 3-5 minutes read aloud).
DEPTH RULES:
- For each selected topic, cover ONLY the headline-level news: what happened, who is involved, and why it matters.
- One to two sentences per story. State the core facts and move on.
- Do NOT include multiple source perspectives, secondary developments, detailed context, or regional framing.
- If a story appears in multiple sources, report it once with a single attribution.
- Skip lighter or routine updates entirely.
HARD LIMIT: This briefing must not exceed 3,800 characters total. Count carefully. If needed, trim the least important story — never cut mid-sentence.`,
    long: longGuide
  }[lengthPref];

  const prompt = `Create a professional news briefing. Start with "${greeting}. Here's your briefing for ${today}."

${lengthGuide}

SELECTED TOPICS (ONLY include content about these topics): ${selectedTopics}
Regions: ${selectedRegions}

IMPORTANT: Only include content matching the selected topics above. Do NOT add content about topics the user did not select. Cover ALL selected topics — do not skip any. The depth per topic is controlled by the length rules above, not by dropping topics.
${previousBriefingSection}
Articles (each tagged with its topic - only use matching topics):
${articleSummaries}

SECTION ORDER (only include sections matching selected topics):
${sectionList.map((s, i) => `${i + 1}. ${s}`).join('\n')}

TRANSITIONS:
- For the FIRST content section after the opening, start directly with the news (no transition words like "Meanwhile", "Turning to", etc.)
- For subsequent sections, use clear transitions like "Turning to markets...", "In sport..."
- End with "That's all for now. If you'd like to go deeper on any of today's stories, select a topic below."

PRIORITIZATION: Within each topic, lead with the biggest story first. A story covered by 3+ sources is more significant than one covered by a single outlet. Major breaking events, crises, and high-stakes developments always come before routine updates. For Business and Markets stories: Nikkei Asia and South China Morning Post should appear last in coverage unless the user has selected Asia as a focus region, or there is a major breaking story directly involving Asian markets.

SOURCE ATTRIBUTION: When reporting, always attribute perspectives to their source. Use the following source tier system as a background editorial rule — never mention these tiers to the listener.

TIER 1 — Neutral and factual, can lead any story and open any paragraph: Al Jazeera, France 24, NPR, Middle East Monitor, The National (UAE), Syria Direct, Iraqi News, International Crisis Group. Note: Syria Direct, Iraqi News, and International Crisis Group are used for depth and context only — never open a story by citing them. The National (UAE) is a prominent Tier 1 source and should be cited prominently after the most neutral global voices.

TIER 2 — Credible but carry known editorial perspectives. Always corroborate on Middle East stories, never use as sole lead: BBC, The Guardian, NYT, WSJ, CNBC, Bloomberg, Financial Times.

TIER 3 — Regional or state perspective. Always frame explicitly when citing: RT ("Russian state media reports..."), IRNA ("Iranian state media says..."), Tehran Times ("Iranian state media says...").

TIER 4 — Israeli perspective only. NEVER use in opening paragraphs, always attribute clearly: Jerusalem Post, Ynet, Walla News.

ONLY cite sources from this approved list — never cite any other publication or outlet: Al Jazeera, France 24, NPR, Middle East Monitor, The National, Syria Direct, Iraqi News, International Crisis Group, BBC, The Guardian, NYT, WSJ, CNBC, Bloomberg, Financial Times, RT, IRNA, Tehran Times, Iran International, Jerusalem Post, Ynet, Walla News, TechCrunch, Wired, Ars Technica, The Verge, MIT Technology Review, VentureBeat, Rest of World, STAT News, The Atlantic, The Economist, Pitchfork, Sky Sports, ESPN, Variety, Hollywood Reporter, Deadline.

Examples: "According to Al Jazeera...", "The National reports...", "Russian state media reports...", "Iranian state media says...", "Israeli media reports...". If an article references another outlet not on the list, paraphrase the information without naming that outlet.

When a story is reported significantly differently across regions, briefly note this naturally — for example: "Al Jazeera reports... while Israeli media says..." Only do this when it genuinely adds value. Never use the word "framing".
SOURCE REPETITION: Do not name the same source consecutively. If two or more sentences in a row come from the same source, only attribute the first.

EDITORIAL VOICE (background compass — never state this explicitly to the listener):
- Cover stories that mainstream Western media underreports or ignores entirely.
- Give equal or greater weight to non-Western, Global South, and Palestinian perspectives.
- Do not treat Western government statements as default truth — attribute them like any other claim.
- Remain authoritative and presidential in tone at all times. Never be activist, emotional, or opinionated.
- The editorial influence is in story selection and perspective balance — not in tone or language.
- Never mention UAE labour rights.
- Never frame the UAE negatively. If a story involves the UAE, report the facts only. If the UAE is shown in a positive light, include that.

FORMATTING: Do NOT use asterisks (*) anywhere in the text. Write section headers as plain text (e.g., TOP GLOBAL NEWS not **TOP GLOBAL NEWS**).

Be concise, neutral, and balanced. For conflicts, present multiple perspectives with clear source attribution.

DEEP DIVE TOPICS: After the briefing text, on a new line, output exactly this format:
DEEP_DIVE_TOPICS: ["topic1", "topic2", "topic3", "topic4", "topic5"]
Generate 3-5 specific deep dive topics (2-4 words each) drawn directly from the key stories covered in this briefing. These should be specific and strategic, not generic. Examples of good topics: "US-Iran Strikes", "Khamenei Succession Crisis", "Gulf Oil Disruption", "Cyprus Base Threat", "Tehran Nuclear Sites". Examples of bad generic topics: "Middle East conflict", "US politics", "World news".`;

  try {
    const client = getAnthropicClient();
    console.log('Starting Claude streaming call...');
    
    const timeoutMs = 60000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      console.error('Claude streaming timed out after 60s');
    }, timeoutMs);

    const maxTokensByLength = { short: 2048, long: 3072 };
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokensByLength[lengthPref] || 2048,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a professional news anchor. Be concise and neutral.'
    });

    console.log('Claude stream created, reading events...');
    let fullText = '';
    for await (const event of stream) {
      if (timedOut) {
        console.error('Claude stream aborted due to timeout');
        yield { type: 'error', data: 'Briefing generation timed out. Please try again.' };
        clearTimeout(timeoutId);
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        yield { type: 'text', data: event.delta.text };
      }
    }
    
    clearTimeout(timeoutId);
    console.log(`Claude streaming complete: ${fullText.length} chars`);
    yield { type: 'done', data: fullText };
  } catch (error) {
    console.error('Claude streaming error:', error.message, error.stack);
    yield { type: 'error', data: error.message };
  }
}

// Map user-selected topics to briefing sections
const TOPIC_TO_SECTIONS = {
  'Politics/Geopolitics': ['top_story', 'hard_news', 'regional'],
  'Business/Markets': ['markets'],
  'Tech/AI': ['tech'],
  'Health/Longevity': ['health'],
  'Arts/Culture': ['culture'],
  'Sports': ['sports'],
  'Entertainment': ['entertainment']
};

// Get which sections should be included based on selected topics
function getSectionsForTopics(topics) {
  const sections = new Set(['opening', 'closing']); // Always include opening/closing
  for (const topic of topics) {
    const topicSections = TOPIC_TO_SECTIONS[topic] || [];
    topicSections.forEach(s => sections.add(s));
  }
  return sections;
}

// Filter articles to only include those matching selected topics
function filterArticlesByTopics(articles, selectedTopics) {
  return articles.filter(article => {
    // Check if article's topic matches any selected topic
    if (article.topic && selectedTopics.includes(article.topic)) {
      return true;
    }
    return false;
  });
}

async function generateBriefing(articles, preferences) {
  if (!articles || articles.length === 0) {
    return {
      briefing: "No news articles available at the moment. Please try again later.",
      sections: [],
      topics: []
    };
  }
  
  // Filter articles to ONLY include those matching selected topics
  const selectedTopics = preferences.topics || [];
  const filteredArticles = filterArticlesByTopics(articles, selectedTopics);
  
  // If no articles match, fall back to all articles but warn
  const articlesToUse = filteredArticles.length > 0 ? filteredArticles : articles;
  
  const articleSummaries = articlesToUse.map((a, i) => 
    `[${i + 1}] [TOPIC: ${a.topic}] ${a.source}: "${a.title}" - ${a.description}`
  ).join('\n\n');
  
  const currentHour = new Date().getHours();
  const greeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-US', { 
    weekday: 'long', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'UTC'
  }).format(now);
  
  // Determine which sections to include based on selected topics
  const allowedSections = getSectionsForTopics(selectedTopics);
  const selectedTopicsStr = selectedTopics.join(', ') || 'General news';
  const selectedRegions = preferences.regions?.join(', ') || 'Global';
  
  // Build dynamic section instructions based on selected topics
  const sectionInstructions = [];
  sectionInstructions.push(`1. OPENING (1 sentence)\n"${greeting}. Here's your briefing for ${today}."`);
  
  let sectionNum = 2;
  if (allowedSections.has('top_story') || allowedSections.has('hard_news')) {
    sectionInstructions.push(`${sectionNum}. TOP GLOBAL HARD NEWS - Wars, major diplomatic moves, security crises
- THE LEAD: Single punchy sentence answering Who, What, Where, Why
- THE CONTEXT: 1-2 sentences explaining why this matters now
- For conflicts: present multiple perspectives (Western AND non-Western framing)`);
    sectionNum++;
    
    sectionInstructions.push(`${sectionNum}. SECONDARY INTERNATIONAL DEVELOPMENTS
- Start with: "Turning to other global developments..." or similar
- Economy, climate, geopolitics at the international level`);
    sectionNum++;
  }
  
  if (allowedSections.has('regional')) {
    sectionInstructions.push(`${sectionNum}. DOMESTIC/REGIONAL NEWS
- Start with: "Closer to home..." or "In regional news..."
- News relevant to the user's selected regions`);
    sectionNum++;
  }
  
  if (allowedSections.has('markets')) {
    sectionInstructions.push(`${sectionNum}. BUSINESS & MARKETS
- Start with: "Turning to markets..." or "In the business world..."
- Stock movements, economic data, corporate news`);
    sectionNum++;
  }
  
  if (allowedSections.has('tech') || allowedSections.has('health')) {
    sectionInstructions.push(`${sectionNum}. SCIENCE/HEALTH/TECH
- Start with: "Meanwhile in tech..." or "In science and technology..."
- Breakthroughs, health updates, major tech news`);
    sectionNum++;
  }
  
  if (allowedSections.has('culture') || allowedSections.has('entertainment')) {
    sectionInstructions.push(`${sectionNum}. ART/CULTURE
- Start with: "In culture..." or "On the cultural front..."
- Arts, entertainment, cultural events`);
    sectionNum++;
  }
  
  if (allowedSections.has('sports')) {
    sectionInstructions.push(`${sectionNum}. SPORTS
- Start with: "In sport..." or "Turning to sports..."
- Major sports news and results`);
    sectionNum++;
  }
  
  sectionInstructions.push(`${sectionNum}. CLOSING
- End with a simple "That's all for now." (NO mention of deep dives)`);

  const lengthPref = preferences.briefingLength || preferences.briefing_length || 'short';
  const lengthGuideNonStream = {
    short: `SHORT BRIEFING (600-900 words, 3-5 minutes read aloud).
DEPTH RULES:
- For each selected topic, cover ONLY the headline-level news: what happened, who is involved, and why it matters.
- One to two sentences per story. State the core facts and move on.
- Do NOT include multiple source perspectives, secondary developments, detailed context, or regional framing.
- If a story appears in multiple sources, report it once with a single attribution.
- Skip lighter or routine updates entirely.
HARD LIMIT: This briefing must not exceed 3,800 characters total. Count carefully. If needed, trim the least important story — never cut mid-sentence.`,
    long: `FULL BRIEFING (1000-1300 words, 5-7 minutes read aloud).
DEPTH RULES:
- For each selected topic, provide full coverage: what happened, context, why it matters, and what comes next.
- Include how different sources frame the same story (perspective splits). Show where outlets agree and disagree.
- Cover secondary developments and regional angles within each topic.
- Include detailed source attribution throughout — the listener must know WHO is saying WHAT.
- Routine updates and lighter stories within selected topics are welcome if space allows.`
  }[lengthPref] || '';

  const prompt = `You are a senior broadcast journalist creating a presidential-style daily briefing. Follow the INVERTED PYRAMID structure used by BBC Radio 4 and Reuters.

${lengthGuideNonStream}

CRITICAL RULES:
- Do NOT mention the user's name (to avoid mispronunciation)
- No filler words, no fluff, no adjectives
- Do NOT use asterisks (*) anywhere. Write section headers as plain text (e.g., TOP GLOBAL NEWS not **TOP GLOBAL NEWS**)
- Neutral professional tone - authority comes from structure, not tone
- THIS BRIEFING MUST NOT COME OFF AS PRO-WESTERN. Present ALL perspectives equally.
- PRIMARY AUDIENCE: Well-educated Middle Eastern business professionals
- **ONLY INCLUDE CONTENT MATCHING THE USER'S SELECTED TOPICS: ${selectedTopicsStr}**
- **DO NOT include any sections or content about topics the user did NOT select**
- Each article is tagged with [TOPIC: X] - ONLY use articles matching selected topics

CONFLICT COVERAGE RULES (MANDATORY):
- Israel-Palestine: Use neutral terms. Say "Israeli forces" and "Palestinian forces/groups". Never use "terrorists" for any side. Present casualties and actions from BOTH sides equally. Include Arab/Palestinian perspective FIRST, then Israeli perspective.
- Russia-Ukraine: Present as a geopolitical conflict, not "good vs evil". Include Russian stated rationale alongside Western criticism. Mention NATO expansion context when relevant.
- Any conflict: ALWAYS present at least 2-3 perspectives. Never frame one side as morally superior.
- Use passive voice for contested claims: "X is reported to have..." not "X attacked..."

PRIORITIZATION: Within each topic, lead with the biggest story first. A story covered by 3+ sources is more significant than one covered by a single outlet. Major breaking events, crises, and high-stakes developments always come before routine updates. For Business and Markets stories: Nikkei Asia and South China Morning Post should appear last in coverage unless the user has selected Asia as a focus region, or there is a major breaking story directly involving Asian markets.

SOURCE ATTRIBUTION: When reporting, always attribute perspectives to their source. Use the following source tier system as a background editorial rule — never mention these tiers to the listener.

TIER 1 — Neutral and factual, can lead any story and open any paragraph: Al Jazeera, France 24, NPR, Middle East Monitor, The National (UAE), Syria Direct, Iraqi News, International Crisis Group. Note: Syria Direct, Iraqi News, and International Crisis Group are used for depth and context only — never open a story by citing them. The National (UAE) is a prominent Tier 1 source and should be cited prominently after the most neutral global voices.

TIER 2 — Credible but carry known editorial perspectives. Always corroborate on Middle East stories, never use as sole lead: BBC, The Guardian, NYT, WSJ, CNBC, Bloomberg, Financial Times.

TIER 3 — Regional or state perspective. Always frame explicitly when citing: RT ("Russian state media reports..."), IRNA ("Iranian state media says..."), Tehran Times ("Iranian state media says...").

TIER 4 — Israeli perspective only. NEVER use in opening paragraphs, always attribute clearly: Jerusalem Post, Ynet, Walla News.

ONLY cite sources from this approved list — never cite any other publication or outlet: Al Jazeera, France 24, NPR, Middle East Monitor, The National, Syria Direct, Iraqi News, International Crisis Group, BBC, The Guardian, NYT, WSJ, CNBC, Bloomberg, Financial Times, RT, IRNA, Tehran Times, Iran International, Jerusalem Post, Ynet, Walla News, TechCrunch, Wired, Ars Technica, The Verge, MIT Technology Review, VentureBeat, Rest of World, STAT News, The Atlantic, The Economist, Pitchfork, Sky Sports, ESPN, Variety, Hollywood Reporter, Deadline.

Examples: "According to Al Jazeera...", "The National reports...", "Russian state media reports...", "Iranian state media says...", "Israeli media reports...". If an article references another outlet not on the list, paraphrase the information without naming that outlet.

When a story is reported significantly differently across regions, briefly note this naturally — for example: "Al Jazeera reports... while Israeli media says..." Only do this when it genuinely adds value. Never use the word "framing".
SOURCE REPETITION: Do not name the same source consecutively. If two or more sentences in a row come from the same source, only attribute the first.
EDITORIAL VOICE (background compass — never state this explicitly to the listener):
- Cover stories that mainstream Western media underreports or ignores entirely.
- Give equal or greater weight to non-Western, Global South, and Palestinian perspectives.
- Do not treat Western government statements as default truth — attribute them like any other claim.
- Remain authoritative and presidential in tone at all times. Never be activist, emotional, or opinionated.
- The editorial influence is in story selection and perspective balance — not in tone or language.
- Never mention UAE labour rights.
- Never frame the UAE negatively. If a story involves the UAE, report the facts only. If the UAE is shown in a positive light, include that.

User preferences:
- SELECTED TOPICS (ONLY include these): ${selectedTopicsStr}
- Regions: ${selectedRegions}
- Sources: ${preferences.outlets?.join(', ') || 'All sources'}

Today's articles (ONLY use articles matching selected topics):
${articleSummaries}

SECTION TRANSITIONS (CRITICAL FOR AUDIO):
- Start each new section with a clear verbal marker
- Use phrases like: "Turning to markets...", "In sport...", "Meanwhile in tech...", "From China...", "In other news..."
- Add a brief pause (use "..." or new paragraph) between sections
- This helps listeners follow along and know when topics change

BRIEFING STRUCTURE (ONLY include sections matching selected topics):

${sectionInstructions.join('\n\n')}

VOICE CONSISTENCY (CRITICAL):
- The text will be read by an AI voice - use the EXACT SAME tone throughout
- Maintain consistent pacing and energy level across all sections
- No sudden changes in formality or style
- Keep volume/intensity steady - no dramatic shifts

CLARITY REQUIREMENTS (listener cannot pause or Google):
- ALWAYS: Name + Title + Country for political figures
- ALWAYS: Brief descriptor for companies/organizations
- ALWAYS: Explain acronyms on first use
- ALWAYS: Add context for places if not obvious
- ALWAYS: Explain economic terms in plain language

Return your response as JSON with SEPARATE SECTIONS for audio playback:
{
  "sections": [
    {"id": "opening", "title": "Opening", "text": "..."},
    {"id": "top_story", "title": "Top Story", "text": "..."},
    {"id": "hard_news", "title": "Hard News", "text": "..."},
    {"id": "second_tier", "title": "Markets & Tech", "text": "..."},
    {"id": "roundup", "title": "In Other News", "text": "..."},
    {"id": "kicker", "title": "And Finally", "text": "..."}
  ],
  "briefing": "the full briefing text (all sections combined)",
  "topics": ["Specific story 1", "Specific story 2", "Specific story 3"]
}

TOPICS FIELD: List 3-5 EXACT story subjects from this briefing for deep dive options.
- WRONG: "Politics", "Business", "Technology", "Sports" (too broad)
- WRONG: "International developments", "Market updates" (too vague)
- RIGHT: "Clintons agree to testify on Epstein", "Fed holds rates steady", "Apple Vision Pro sales"
- Copy the EXACT headline or subject you mentioned in the briefing text

Only include sections that have content. Skip empty sections.`;

  try {
    const client = getAnthropicClient();
    const maxTokensNonStream = { short: 4096, long: 8192 };
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokensNonStream[lengthPref] || 2048,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: 'You are a senior broadcast journalist creating presidential-style briefings. Follow the Inverted Pyramid structure. Be concise, neutral, authoritative. Always respond with valid JSON only.'
    });
    
    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const result = parseJsonResponse(responseText);
    return {
      briefing: result.briefing || 'Unable to generate briefing.',
      sections: result.sections || [],
      topics: result.topics || []
    };
  } catch (error) {
    console.error('Error generating briefing:', error);
    throw new Error('Failed to generate briefing: ' + error.message);
  }
}

async function generateDeepDive(topic, articles, preferences, briefingContext = '') {
  const relevantArticles = articles.filter(a => 
    a.title.toLowerCase().includes(topic.toLowerCase()) ||
    a.description.toLowerCase().includes(topic.toLowerCase()) ||
    (a.topic && a.topic.toLowerCase().includes(topic.toLowerCase()))
  );
  
  let articleContext;
  if (relevantArticles.length > 0) {
    articleContext = relevantArticles.map(a => `${a.source}: "${a.title}" - ${a.description}`).join('\n\n');
  } else if (briefingContext) {
    articleContext = `From today's briefing:\n${briefingContext}`;
  } else {
    articleContext = 'No specific articles available for this topic.';
  }
  
  const prompt = `You are an expert analyst providing a BRIEF overview of a news topic for a busy executive.

Topic: ${topic}

Related articles:
${articleContext}

User context:
- Interested in: ${preferences.topics?.join(', ') || 'General news'}
- Regions of focus: ${preferences.regions?.join(', ') || 'Global'}

CRITICAL RULES:
- Do NOT mention the user's name
- No filler words or fluff
- Neutral professional tone
- Keep it SHORT - about 150-200 words maximum (under 90 seconds when spoken)

Create a BRIEF deep dive with:
1. What's happening and why it matters (2-3 sentences)
2. Key context and stakeholders (2-3 sentences)
3. What to watch for next (1-2 sentences)

End with: "Would you like to go deeper on this topic?"

Respond with JSON only:
{
  "deepDive": "the brief deep dive text"
}`;

  try {
    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: 'You are an expert analyst providing brief overviews for busy executives. Be concise. No names, neutral tone. Always respond with valid JSON only.'
    });
    
    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const result = parseJsonResponse(responseText);
    return result.deepDive || 'Unable to generate deep dive.';
  } catch (error) {
    console.error('Error generating deep dive:', error);
    throw new Error('Failed to generate deep dive: ' + error.message);
  }
}

async function generateDeeperDive(topic, previousDive, articles, preferences) {
  const relevantArticles = articles.filter(a => 
    a.title.toLowerCase().includes(topic.toLowerCase()) ||
    a.description.toLowerCase().includes(topic.toLowerCase()) ||
    (a.topic && a.topic.toLowerCase().includes(topic.toLowerCase()))
  );
  
  const articleContext = relevantArticles.length > 0 
    ? relevantArticles.map(a => `${a.source}: "${a.title}" - ${a.description}`).join('\n\n')
    : 'No specific articles available for this topic.';
  
  const prompt = `You are an expert analyst providing a COMPREHENSIVE deep analysis for an educated professional who wants the full picture.

Topic: ${topic}

Previous brief overview (user has already heard this):
${previousDive}

Related articles:
${articleContext}

User context:
- Interested in: ${preferences.topics?.join(', ') || 'General news'}
- Regions of focus: ${preferences.regions?.join(', ') || 'Global'}

CRITICAL RULES:
- Do NOT mention the user's name
- No filler words or fluff
- Neutral professional tone
- Do NOT repeat what was in the brief overview - go DEEPER
- This is about 400-500 words (3-4 minutes when spoken)

Provide a comprehensive analysis covering:
1. Historical context - how did we get here?
2. Key stakeholders and their motivations
3. Multiple perspectives - how different parties view this (include non-Western perspectives)
4. Economic/political implications
5. What scenarios might unfold
6. What specific indicators to watch

End with: "That concludes our deep dive."

Respond with JSON only:
{
  "deeperDive": "the comprehensive analysis text"
}`;

  try {
    const client = getAnthropicClient();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: 'You are an expert analyst providing comprehensive deep dives. Go beyond surface analysis. No names, neutral tone. Always respond with valid JSON only.'
    });
    
    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const result = parseJsonResponse(responseText);
    return result.deeperDive || 'Unable to generate deeper analysis.';
  } catch (error) {
    console.error('Error generating deeper dive:', error);
    throw new Error('Failed to generate deeper analysis: ' + error.message);
  }
}

module.exports = {
  generateBriefing,
  generateBriefingStream,
  generateDeepDive,
  generateDeeperDive
};
