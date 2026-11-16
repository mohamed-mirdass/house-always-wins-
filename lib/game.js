'use strict';
/* ROYAL SPIN - logique du jeu, compatible Vercel (serverless).
   - Tout l'état de la partie vit dans UN document JSON (Redis en ligne, data.json en local).
   - Plus de timers ni de WebSocket: les temporisations (décompte, tirage, résultat)
     sont calculées à la demande à partir des horodatages (deadline / spinEnd).
   - Les clients interrogent POST /api/rpc (voir public/rs-socket.js). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Redis } = require('@upstash/redis');

const PORT = +process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || '';
const ON_VERCEL = !!process.env.VERCEL;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;
const STATE_KEY = process.env.REDIS_STATE_KEY || 'royal-spin:game';
const LOCK_KEY = STATE_KEY + ':lock';
const SEEN_KEY = STATE_KEY + ':seen';

const START_BALANCE = 1000;
const CHIPS = [10, 50, 100, 500];
const SPIN_MS = +process.env.SPIN_MS || 7000;
const RESULT_MS = +process.env.RESULT_MS || 10000;
const SLOT_MS = 2200;
const ONLINE_MS = 12000;
const MAX_PLAYERS = 300;
const AVATARS = ['🦁', '🐯', '🦊', '🐼', '🐲', '🦄', '🦅', '🐺', '🤖', '👑', '😎', '🎩'];

/* ---------------------------------------------------------------- roulette */
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = n => (n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black');
const MULT = { n: 36, red: 2, black: 2, even: 2, odd: 2, low: 2, high: 2, d1: 3, d2: 3, d3: 3, c1: 3, c2: 3, c3: 3 };
const rnd = n => crypto.randomInt(0, n);

function betWins(b, n) {
  switch (b.type) {
    case 'n': return n === b.value;
    case 'red': return colorOf(n) === 'red';
    case 'black': return colorOf(n) === 'black';
    case 'even': return n !== 0 && n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'low': return n >= 1 && n <= 18;
    case 'high': return n >= 19 && n <= 36;
    case 'd1': return n >= 1 && n <= 12;
    case 'd2': return n >= 13 && n <= 24;
    case 'd3': return n >= 25 && n <= 36;
    case 'c1': return n !== 0 && n % 3 === 1;
    case 'c2': return n !== 0 && n % 3 === 2;
    case 'c3': return n !== 0 && n % 3 === 0;
  }
  return false;
}

/* ------------------------------------------------------------------- état */
function fresh() {
  return {
    players: [], counts: Array(37).fill(0), history: [], round: 1,
    game: { phase: 'betting', result: null, deadline: 0, spinEnd: 0, auto: false },
    betMs: 25000, chosenUrl: ''
  };
}
function newPlayer(id, name, avatar) {
  return {
    id, name, avatar, balance: START_BALANCE, wagered: 0, wins: 0, best: 0, straights: 0, streak: 0, refills: 0,
    bets: [], log: [], lastBets: [], res: null, busy: false, bj: null, pend: null
  };
}
const getP = (st, id) => st.players.find(p => p.id === id);
const betsTotal = p => p.bets.reduce((s, b) => s + b.amount, 0);

/* ---------------------------------------------------------- stockage (Redis / fichier) */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const redisStore = {
  async read(touchId, now) {
    const pl = redis.pipeline();
    if (touchId) pl.zadd(SEEN_KEY, { score: now, member: touchId });
    pl.get(STATE_KEY);
    pl.zrange(SEEN_KEY, now - ONLINE_MS, '+inf', { byScore: true });
    if (touchId && Math.random() < 0.02) pl.zremrangebyscore(SEEN_KEY, 0, now - 3600000);
    const r = await pl.exec();
    const off = touchId ? 1 : 0;
    let st = r[off];
    if (typeof st === 'string') st = JSON.parse(st);
    return { st: st || fresh(), online: new Set(r[off + 1] || []) };
  },
  async load() {
    let st = await redis.get(STATE_KEY);
    if (typeof st === 'string') st = JSON.parse(st);
    return st || fresh();
  },
  async save(st) { await redis.set(STATE_KEY, JSON.stringify(st)); },
  async online(now) { return new Set((await redis.zrange(SEEN_KEY, now - ONLINE_MS, '+inf', { byScore: true })) || []); },
  async touch(id, now) { await redis.zadd(SEEN_KEY, { score: now, member: id }); },
  async withLock(fn) {
    const token = crypto.randomUUID();
    let got = false;
    for (let i = 0; i < 50 && !got; i++) {
      got = await redis.set(LOCK_KEY, token, { nx: true, px: 5000 });
      if (!got) await sleep(40 + rnd(60));
    }
    if (!got) throw new Error('Serveur occupé, réessayez.');
    try { return await fn(); }
    finally { try { if ((await redis.get(LOCK_KEY)) === token) await redis.del(LOCK_KEY); } catch (e) { /* ignore */ } }
  }
};

const fileStore = {
  st: null, seen: new Map(), chain: Promise.resolve(),
  _load() {
    if (!this.st) { try { this.st = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { this.st = fresh(); } }
    return this.st;
  },
  async read(touchId, now) {
    if (touchId) this.seen.set(touchId, now);
    return { st: this._load(), online: await this.online(now) };
  },
  async load() { return this._load(); },
  async save(st) {
    this.st = st;
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(st)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.error('Sauvegarde impossible:', e.message); }
  },
  async online(now) { return new Set([...this.seen].filter(([, t]) => now - t < ONLINE_MS).map(([id]) => id)); },
  async touch(id, now) { this.seen.set(id, now); },
  withLock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
};
const store = redis ? redisStore : fileStore;

/* -------------------------------------------------------------- cycle de jeu */
function schedAuto(st, t) {
  const g = st.game; g.deadline = 0;
  if (!g.auto) return;
  if (g.phase === 'betting') g.deadline = t + st.betMs;
  else if (g.phase === 'result') g.deadline = t + RESULT_MS;
}
function startBetting(st, t) {
  const g = st.game;
  g.phase = 'betting'; g.result = null; g.spinEnd = 0;
  for (const p of st.players) { p.bets = []; p.log = []; }
  schedAuto(st, t);
}
function nextRound(st, t) { st.round++; startBetting(st, t); }
function spin(st, t) {
  const g = st.game;
  if (g.phase !== 'betting') return;
  g.result = rnd(37); g.phase = 'spinning'; g.deadline = 0; g.spinEnd = t + SPIN_MS;
}
function settle(st, t) {
  const g = st.game, n = g.result;
  st.history.unshift(n); st.history = st.history.slice(0, 100); st.counts[n]++;
  for (const p of st.players) {
    const stake = betsTotal(p);
    let win = 0, hitStraight = false;
    for (const b of p.bets) if (betWins(b, n)) { win += b.amount * MULT[b.type]; if (b.type === 'n') hitStraight = true; }
    p.res = { round: st.round, stake, win };
    if (stake > 0) {
      p.wagered += stake; p.balance += win;
      if (win > stake) { p.wins++; p.streak++; p.best = Math.max(p.best, win - stake); }
      else if (win < stake) p.streak = 0;
      if (hitStraight) p.straights++;
      p.lastBets = p.bets.map(b => ({ ...b }));
    }
  }
  g.phase = 'result';
  schedAuto(st, t);
}

/* Avance les temporisations échues. Renvoie true si l'état a changé. */
function due(st, now) {
  const g = st.game;
  if (st.players.some(p => p.pend && now >= p.pend.at)) return true;
  if (g.phase === 'spinning' && now >= g.spinEnd) return true;
  return !!(g.auto && g.deadline && now >= g.deadline);
}
function advance(st, now) {
  let changed = false;
  const g = st.game;
  for (const p of st.players) {
    if (p.pend && now >= p.pend.at) {
      const { win, amount } = p.pend;
      p.balance += win; p.busy = false; p.wagered += amount; p.pend = null;
      if (win > amount) { p.wins++; p.best = Math.max(p.best, win - amount); }
      changed = true;
    }
  }
  const base = t => (now - t > 5000 ? now : t); // pas de rattrapage après une longue pause
  for (let i = 0; i < 6; i++) {
    if (g.phase === 'spinning' && now >= g.spinEnd) { settle(st, base(g.spinEnd)); changed = true; continue; }
    if (g.auto && g.deadline && now >= g.deadline) {
      const t = base(g.deadline);
      if (g.phase === 'betting') spin(st, t); else if (g.phase === 'result') nextRound(st, t);
      changed = true; continue;
    }
    break;
  }
  return changed;
}

/* ----------------------------------------------------------- vues publiques */
function pub(st, online, now) {
  const g = st.game, inResult = g.phase === 'result';
  return {
    round: st.round, phase: g.phase, result: g.phase === 'betting' ? null : g.result,
    history: st.history.slice(0, 24), counts: st.counts, deadline: g.deadline, spinEnd: g.spinEnd,
    spinMs: SPIN_MS, betMs: st.betMs, auto: g.auto, serverTime: now, chips: CHIPS,
    online: st.players.filter(p => online.has(p.id)).length,
    players: st.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, balance: p.balance, wagered: p.wagered, wins: p.wins,
      best: p.best, straights: p.straights, streak: p.streak, online: online.has(p.id),
      betting: p.bets.length > 0, net: inResult && p.res && p.res.round === st.round ? p.res.win - p.res.stake : 0
    }))
  };
}

const HIDDEN = { hidden: true };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function handValue(h) {
  let t = 0, aces = 0;
  for (const c of h) {
    if (c.r === 'A') { aces++; t += 11; }
    else if (c.r === '10' || c.r === 'J' || c.r === 'Q' || c.r === 'K') t += 10;
    else t += +c.r;
  }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
function bjView(b) {
  const done = b.status === 'done';
  return {
    bet: b.bet, player: b.player, dealer: done ? b.dealer : [b.dealer[0], HIDDEN],
    pv: handValue(b.player), dv: done ? handValue(b.dealer) : handValue([b.dealer[0]]),
    status: b.status, outcome: b.outcome, payout: b.payout, canDouble: b.status === 'playing' && b.player.length === 2
  };
}
function meFor(p) {
  if (!p) return null;
  return { balance: p.balance, bets: p.bets, total: betsTotal(p), hasLast: p.lastBets.length > 0, busy: p.busy, res: p.res, bj: p.bj ? bjView(p.bj) : null };
}

/* ------------------------------------------------------------ machine à sous */
const SLOT = [['🍒', 30, 10], ['🍋', 25, 12], ['🔔', 20, 20], ['⭐', 12, 50], ['7️⃣', 8, 100], ['💎', 5, 250]];
function pickSlot() { let r = rnd(100); for (const s of SLOT) { if (r < s[1]) return s; r -= s[1]; } return SLOT[0]; }

/* ---------------------------------------------------------------- blackjack */
function newDeck() {
  const d = [];
  for (const s of ['♠', '♥', '♦', '♣']) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function bjFinish(p) {
  const b = p.bj, pv = handValue(b.player);
  if (pv <= 21) while (handValue(b.dealer) < 17) b.dealer.push(b.deck.pop());
  const dv = handValue(b.dealer);
  let outcome, payout;
  if (pv > 21) { outcome = 'bust'; payout = 0; }
  else if (b.natural) { outcome = dv === 21 && b.dealer.length === 2 ? 'push' : 'blackjack'; payout = outcome === 'push' ? b.bet : b.bet * 2.5; }
  else if (dv > 21 || pv > dv) { outcome = 'win'; payout = b.bet * 2; }
  else if (pv === dv) { outcome = 'push'; payout = b.bet; }
  else { outcome = 'lose'; payout = 0; }
  b.status = 'done'; b.outcome = outcome; b.payout = payout; b.deck = null;
  p.balance += payout; p.wagered += b.bet;
  if (payout > b.bet) { p.wins++; p.best = Math.max(p.best, payout - b.bet); }
}

/* ------------------------------------------------------------------- réseau */
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function isLocalIp(ip) { return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1'; }
function authorized(key, ip) {
  if (HOST_KEY) return safeEq(key, HOST_KEY);
  return !ON_VERCEL && isLocalIp(ip);
}

function lanCandidates() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      let score = 0;
      if (/virtual|vbox|vmware|vethernet|wsl|docker|hyper|loopback|tap|tun|bluetooth/i.test(name)) score -= 10;
      if (/wi-?fi|wlan|wireless|en0|^wl/i.test(name)) score += 2;
      if (/ethernet|^eth|^en\d/i.test(name)) score += 1;
      if (n.address.startsWith('192.168.56.') || n.address.startsWith('192.168.99.')) score -= 5;
      if (n.address.startsWith('192.168.')) score += 3;
      else if (n.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(n.address)) score += 1;
      if (n.address.startsWith('169.254.')) score -= 20;
      out.push({ ip: n.address, name, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
const qrCache = new Map();
async function qrFor(url) {
  if (!qrCache.has(url)) qrCache.set(url, await QRCode.toDataURL(url, { width: 360, margin: 1 }));
  return qrCache.get(url);
}
async function joinInfo(st, headers) {
  const host = headers['x-forwarded-host'] || headers.host || `localhost:${PORT}`;
  const hostname = host.split(':')[0];
  let urls;
  if (process.env.PUBLIC_URL) urls = [process.env.PUBLIC_URL.replace(/\/$/, '')];
  else if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    urls = lanCandidates().map(c => `http://${c.ip}:${PORT}`);
    if (!urls.length) urls = [`http://localhost:${PORT}`];
  } else urls = [`${String(headers['x-forwarded-proto'] || 'https').split(',')[0]}://${host}`];
  const url = urls.includes(st.chosenUrl) ? st.chosenUrl : urls[0];
  return { url, urls, qr: await qrFor(url), hostKeyRequired: !!HOST_KEY };
}

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);

/* ------------------------------------------------------------ événements */
const PLAYER_EVENTS = {
  join({ st, id, d }) {
    if (getP(st, id) || st.players.length >= MAX_PLAYERS) return;
    const name = cleanName(d.name); if (!name) return;
    st.players.push(newPlayer(id, name, AVATARS.includes(d.avatar) ? d.avatar : AVATARS[0]));
  },
  bet({ st, p, d, err }) {
    if (st.game.phase !== 'betting') return err('Les paris sont fermés');
    const { type, amount } = d; let value = d.value;
    if (!CHIPS.includes(amount) || !(type in MULT)) return;
    if (type === 'n') { if (!Number.isInteger(value) || value < 0 || value > 36) return; } else value = null;
    if (p.balance < amount) return err('Solde insuffisant');
    p.balance -= amount;
    const ex = p.bets.find(b => b.type === type && b.value === value);
    if (ex) ex.amount += amount; else p.bets.push({ type, value, amount });
    p.log.push({ type, value, amount });
  },
  undo({ st, p }) {
    if (st.game.phase !== 'betting') return;
    const l = p.log.pop(); if (!l) return;
    const b = p.bets.find(x => x.type === l.type && x.value === l.value);
    if (b) { b.amount -= l.amount; if (b.amount <= 0) p.bets = p.bets.filter(x => x !== b); }
    p.balance += l.amount;
  },
  clearBets({ st, p }) {
    if (st.game.phase !== 'betting') return;
    p.balance += betsTotal(p); p.bets = []; p.log = [];
  },
  rebet({ st, p }) {
    if (st.game.phase !== 'betting') return;
    p.balance += betsTotal(p); p.bets = []; p.log = [];
    for (const b of p.lastBets) {
      if (p.balance < b.amount) continue;
      p.balance -= b.amount; p.bets.push({ ...b }); p.log.push({ ...b });
    }
  },
  refill({ p }) {
    if (p.balance >= 10 || p.bets.length || p.busy || (p.bj && p.bj.status === 'playing')) return;
    p.balance += 500; p.refills++;
  },
  slots({ p, d, now, err, out }) {
    if (p.busy) return;
    const amount = d.amount;
    if (!CHIPS.includes(amount)) return;
    if (p.balance < amount) return err('Solde insuffisant');
    p.balance -= amount; p.busy = true;
    const reels = [pickSlot(), pickSlot(), pickSlot()];
    let mult = 0;
    if (reels[0][0] === reels[1][0] && reels[1][0] === reels[2][0]) mult = reels[0][2];
    else if (reels.filter(r => r[0] === '🍒').length === 2) mult = 1;
    const win = amount * mult;
    p.pend = { win, amount, at: now + SLOT_MS };
    out.push({ ev: 'slotsResult', data: { reels: reels.map(r => r[0]), win, amount, mult } });
  },
  bjDeal({ p, d, err }) {
    if (p.bj && p.bj.status === 'playing') return;
    const amount = d.amount;
    if (!CHIPS.includes(amount)) return;
    if (p.balance < amount) return err('Solde insuffisant');
    p.balance -= amount;
    const deck = newDeck();
    const b = { bet: amount, deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], status: 'playing', outcome: null, payout: 0, natural: false };
    p.bj = b;
    if (handValue(b.player) === 21 || handValue(b.dealer) === 21) { b.natural = handValue(b.player) === 21; bjFinish(p); }
  },
  bjHit({ p }) {
    if (!p.bj || p.bj.status !== 'playing') return;
    p.bj.player.push(p.bj.deck.pop());
    if (handValue(p.bj.player) >= 21) bjFinish(p);
  },
  bjStand({ p }) {
    if (!p.bj || p.bj.status !== 'playing') return;
    bjFinish(p);
  },
  bjDouble({ p, err }) {
    if (!p.bj || p.bj.status !== 'playing' || p.bj.player.length !== 2) return;
    if (p.balance < p.bj.bet) return err('Solde insuffisant');
    p.balance -= p.bj.bet; p.bj.bet *= 2;
    p.bj.player.push(p.bj.deck.pop());
    bjFinish(p);
  }
};

const HOST_EVENTS = {
  spin({ st, now }) { spin(st, now); },
  next({ st, now }) { if (st.game.phase === 'result') nextRound(st, now); },
  auto({ st, d, now }) { st.game.auto = !!d.on; if (st.game.phase !== 'spinning') schedAuto(st, now); },
  betMs({ st, d, now }) {
    const s = Math.max(8, Math.min(120, +d.seconds || 25)); st.betMs = s * 1000;
    if (st.game.auto && st.game.phase === 'betting') schedAuto(st, now);
  },
  resetScores({ st }) {
    for (const p of st.players) Object.assign(p, { balance: START_BALANCE, wagered: 0, wins: 0, best: 0, straights: 0, streak: 0, refills: 0, bets: [], log: [], lastBets: [], res: null, bj: null, pend: null, busy: false });
  },
  reset({ st, now }) {
    st.players = []; st.counts = Array(37).fill(0); st.history = []; st.round = 1;
    startBetting(st, now);
  },
  async setUrl({ st, d, headers, out }) {
    const info = await joinInfo(st, headers);
    if (info.urls.includes(d.url)) { st.chosenUrl = d.url; out.push({ ev: 'info', data: await joinInfo(st, headers) }); }
  }
};

/* --------------------------------------------------------------------- RPC */
/* body: { id, role: 'player'|'tv'|'host', key?, event?, data? }
   Renvoie { msgs: [{ ev, data }] } : mêmes messages qu'avec Socket.IO. */
async function rpc(body, headers, ip) {
  body = body || {};
  const id = body.id, role = body.role;
  if (typeof id !== 'string' || id.length < 4 || id.length > 64 || !['player', 'tv', 'host'].includes(role)) return { msgs: [] };
  if (ON_VERCEL && !redis) throw new Error('Redis non configuré : ajoutez UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN (ou KV_REST_API_URL / KV_REST_API_TOKEN).');
  const event = typeof body.event === 'string' ? body.event : null;
  const d = body.data && typeof body.data === 'object' ? body.data : {};
  const isHost = role === 'host' && authorized(body.key, ip);
  const out = [];
  const err = m => out.push({ ev: 'err', data: m });
  const mutating = !!event && event !== 'hello';
  const touch = role === 'player' ? id : null;
  let st, online, now = Date.now();

  async function run() {
    st = await store.load(); now = Date.now();
    advance(st, now);
    const ctx = { st, id, d, now, err, out, headers, p: getP(st, id) };
    if (role === 'player' && PLAYER_EVENTS[event] && (event === 'join' || ctx.p)) PLAYER_EVENTS[event](ctx);
    else if (isHost && HOST_EVENTS[event]) await HOST_EVENTS[event](ctx);
    await store.save(st);
    if (touch) await store.touch(touch, now);
    online = await store.online(now);
  }

  if (mutating) await store.withLock(run);
  else {
    ({ st, online } = await store.read(touch, now));
    if (due(st, now)) await store.withLock(async () => { st = await store.load(); if (advance(st, now)) await store.save(st); });
  }

  if (event === 'hello') {
    if (role === 'host') {
      if (isHost) { out.push({ ev: 'hostOk' }); out.push({ ev: 'info', data: await joinInfo(st, headers) }); }
      else out.push({ ev: 'hostDenied', data: { keyRequired: !!HOST_KEY } });
    } else if (role === 'tv') out.push({ ev: 'info', data: await joinInfo(st, headers) });
  }
  out.push({ ev: 'state', data: pub(st, online, Date.now()) });
  if (role === 'player') out.push({ ev: 'me', data: meFor(getP(st, id)) });
  return { msgs: out };
}

module.exports = { rpc, store, redis, DATA_FILE, PORT, HOST_KEY, lanCandidates };
