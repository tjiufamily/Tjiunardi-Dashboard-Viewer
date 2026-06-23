/**
 * Vercel proxy for OpenCode Go API (avoids browser CORS).
 * Set OPENCODE_GO_API_KEY in Vercel env (or VITE_OPENCODE_GO_API_KEY as fallback).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENCODE_GO_API_KEY || process.env.VITE_OPENCODE_GO_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OpenCode Go API key not configured on server' });
    return;
  }

  const slug = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path || 'v1/chat/completions';
  const upstream = await fetch(`https://opencode.ai/zen/go/${slug}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(req.body ?? {}),
  });

  const text = await upstream.text();
  res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
}
