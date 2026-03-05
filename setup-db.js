const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE,
      push_subscription JSONB,
      preferences JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS briefings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      content TEXT,
      audio_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_times (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      schedule_times JSONB,
      timezone TEXT,
      updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_update_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      topic TEXT,
      subscribed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, topic)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      subscription JSONB,
      updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id UUID PRIMARY KEY,
      name TEXT,
      email TEXT,
      topics JSONB,
      regions JSONB,
      publications JSONB,
      voice_gender TEXT,
      voice_accent TEXT,
      briefing_length TEXT,
      briefings_per_day INTEGER,
      briefing_times JSONB,
      live_updates_subscribed BOOLEAN DEFAULT FALSE,
      live_updates_declined BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cached_briefings (
      user_id UUID PRIMARY KEY,
      briefing TEXT,
      topics JSONB,
      sections JSONB,
      audio BYTEA,
      generated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('All tables created!');
  await pool.end();
}

setup().catch(console.error);