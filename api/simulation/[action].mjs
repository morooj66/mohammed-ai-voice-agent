// Intentionally closed on Vercel until an approved persistent bridge is connected.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error: 'persistent_bridge_required' });
}
