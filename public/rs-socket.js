/* rs-socket.js - remplace Socket.IO par de simples requêtes HTTP (compatible Vercel).
   Même interface que socket.io-client pour le code existant : io(), on(), emit(), connect(), disconnect().
   Le serveur répond à chaque appel avec la liste des messages à rejouer (state, me, info, err...). */
(function () {
  'use strict';
  window.io = function () {
    const handlers = {};
    let ident = null, connected = false, timer = null, chain = Promise.resolve(), running = false;

    const fire = (ev, d) => (handlers[ev] || []).slice().forEach(f => { try { f(d); } catch (e) { console.error(e); } });
    const delay = () => {
      if (ident && ident.role === 'tv') return 1500;
      return document.hidden ? 6000 : 1500;
    };

    async function call(event, data) {
      if (!ident) return;
      try {
        const r = await fetch('/api/rpc', {
          method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ident.id, role: ident.role, key: ident.key, event, data })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { if (j.error) fire('err', j.error); throw new Error(j.error || 'HTTP ' + r.status); }
        if (!connected) { connected = true; fire('connect'); }
        (j.msgs || []).forEach(m => fire(m.ev, m.data));
      } catch (e) {
        if (connected) { connected = false; fire('disconnect'); }
      }
    }
    const enqueue = (event, data) => { chain = chain.then(() => call(event, data)); return chain; };

    function loop() {
      clearTimeout(timer);
      if (!running) return;
      timer = setTimeout(async () => { await enqueue(connected ? null : 'hello', {}); loop(); }, delay());
    }

    const sock = {
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      emit(ev, data) {
        if (ev === 'hello') {
          ident = { id: data.id, role: data.role, key: data.key || '' };
          running = true;
          enqueue('hello', {}).then(loop);
        } else if (ident) {
          enqueue(ev, data || {}).then(loop);
        }
        return sock;
      },
      disconnect() { running = false; clearTimeout(timer); ident = null; connected = false; return sock; },
      connect() { setTimeout(() => { connected = true; fire('connect'); }, 0); return sock; }
    };
    sock.connect();
    return sock;
  };
})();
