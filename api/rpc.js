'use strict';
const { rpc } = require('../lib/game');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST uniquement' }); return; }
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
    res.status(200).json(await rpc(req.body, req.headers, ip));
  } catch (e) {
    console.error('rpc:', e.message);
    res.status(500).json({ error: e.message });
  }
};
