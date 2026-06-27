import fs from 'node:fs';

const botEnv =
  'C:/Users/tjiun/OneDrive/Documents/Tjiunardi Stock Research Gemini Dashboard/telegrammarketbot/jnthnmarketbot-main/.env';
const env = Object.fromEntries(
  fs
    .readFileSync(botEnv, 'utf8')
    .split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const r = await fetch(`${url}/rest/v1/quote_cache?select=ticker,price,updated_at&order=updated_at.desc&limit=5`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
const rows = await r.json();
const c = await fetch(`${url}/rest/v1/quote_cache?select=ticker`, {
  headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
});
console.log('quote_cache count:', c.headers.get('content-range'));
console.log('latest rows:', JSON.stringify(rows, null, 2));
