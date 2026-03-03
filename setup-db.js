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
  console.log('users table created');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS briefings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      content TEXT,
      audio_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('briefings table created');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_times (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      time TEXT,
      timezone TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('scheduled_times table created');

  await pool.end();
  console.log('All tables created successfully!');
}

setup().catch(console.error);