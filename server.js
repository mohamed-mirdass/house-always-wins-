'use strict';
/* ROYAL SPIN - serveur local (npm start). En ligne sur Vercel, ce fichier n'est pas utilisé:
   ce sont public/ (fichiers statiques) et api/rpc.js (fonction) qui servent le jeu. */
const express = require('express');
const path = require('path');
const { rpc, redis, PORT, HOST_KEY, lanCandidates } = require('./lib/game');

const app = express();
app.use(express.json({ limit: '20kb' }));
app.post('/api/rpc', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await rpc(req.body, req.headers, req.socket.remoteAddress || '')); }
  catch (e) { console.error('rpc:', e.message); res.status(500).json({ error: e.message }); }
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, '0.0.0.0', () => {
  const c = lanCandidates();
  console.log('\n  ROYAL SPIN est lancé.\n');
  console.log(`  Hôte (ce PC)      : http://localhost:${PORT}/host`);
  console.log(`  Écran géant (TV)  : http://localhost:${PORT}/tv`);
  console.log(`  Joueurs (WiFi)    : ${c.length ? c.map(x => `http://${x.ip}:${PORT}`).join('  ou  ') : `http://localhost:${PORT}`}`);
  if (HOST_KEY) console.log('  Clé hôte définie (HOST_KEY) : demandée sur /host');
  console.log(redis ? '  Sauvegarde : Redis.' : '  Sauvegarde : data.json (local).');
  console.log('');
});
