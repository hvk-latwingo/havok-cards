/* Havok Cards — duels en direct (Supabase). Chargé après le jeu : surcharge duel() et play(). */
(function () {
  if (!(window.HV && HV.configured && HV.duel)) return;
  var D = HV.duel, L = null, lob = null, lobT = null;
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var deckIds = function () { return getDeck().map(function (c) { return c.id; }); };
  var inDuel = function () { return S.tab === "duel"; };
  function refresh() { if (inDuel()) render(); }

  window.liveBtn = function () {
    if (!HV.user) return '<div class="sub" style="margin-top:8px">🌐 Connecte-toi pour jouer en direct</div>';
    return '<div class="sub" style="margin-top:8px">Contre un joueur en ligne</div><button class="btn sbtn" onclick="liveOpen()">🌐 Duel en direct</button>';
  };

  var _duel = window.duel, _play = window.play;
  window.duel = function () { if (L) return gameView(); if (lob) return lobbyView(); return _duel(); };
  window.play = function (id) { if (L) return livePick(id); return _play(id); };

  /* ---------- lobby ---------- */
  window.liveOpen = function () {
    if (!HV.user) return toast("Connecte-toi d'abord");
    if (!getDeck().length) return toast("Ouvre un booster d'abord 😎");
    D.mine().then(function (r) { if (r) return start(r); openLobby(); }).catch(function () { openLobby(); });
  };
  function openLobby() { lob = { list: null, msg: "" }; loadLobby(); clearInterval(lobT); lobT = setInterval(function () { if (lob && !L) loadLobby(); else clearInterval(lobT); }, 4000); render(); }
  function loadLobby() {
    D.open().then(function (rows) { if (!lob) return; lob.list = (rows || []).filter(function (r) { return r.host !== HV.user.id; }); lob.msg = ""; refresh(); })
      .catch(function () { if (lob) { lob.msg = "Impossible de charger les duels. Le schema.sql a-t-il été exécuté ?"; refresh(); } });
  }
  window.liveRefresh = function () { loadLobby(); };
  window.liveBack = function () { lob = null; clearInterval(lobT); render(); };
  window.liveCreate = function () {
    D.create(S.pseudo, deckIds()).then(function (row) { start(row); }).catch(function () { toast("Impossible de créer le duel"); });
  };
  window.liveJoin = function (id) {
    D.join(id, S.pseudo, deckIds()).then(function (row) {
      if (!row) { toast("Duel déjà pris 😅"); loadLobby(); return; }
      start(row);
    }).catch(function () { toast("Impossible de rejoindre"); });
  };
  function lobbyView() {
    var l = lob.list;
    return '<div class="h">Duel en direct 🌐</div><div class="pn tc"><div class="sub">Ton deck de ' + getDeck().length + ' cartes est utilisé.</div>' +
      '<button class="btn sbtn" onclick="liveCreate()">➕ Créer un duel</button><button class="btn b sbtn" onclick="liveRefresh()">🔄 Actualiser</button><button class="btn b sbtn" onclick="liveBack()">← Retour</button></div>' +
      (lob.msg ? '<div class="pn tc" style="color:#d62300">' + hesc(lob.msg) + '</div>' : "") +
      '<div class="sub">Duels ouverts</div>' +
      (l == null ? '<div class="pn tc">Chargement…</div>' : !l.length ? '<div class="pn tc">Aucun duel ouvert. Crée le tien et attends un adversaire !</div>' :
        l.map(function (r) { return '<div class="pn"><div class="row"><span>👤 <b>' + hesc(r.host_name || "Joueur") + '</b> · ' + (((r.state || {}).d || {}).h || []).length + ' cartes</span></div><button class="btn sbtn" onclick="liveJoin(\'' + r.id + '\')">⚔️ Rejoindre</button></div>'; }).join(""));
  }

  /* ---------- partie ---------- */
  var unwatch = null, pollT = null;
  function start(row) {
    lob = null; clearInterval(lobT); stop();
    L = { id: row.id, role: row.host === HV.user.id ? "h" : "g", row: row, sup: 0, paid: false };
    unwatch = D.watch(row.id, apply);
    pollT = setInterval(poll, 2000);
    if (row.status === "done") pay();
    S.tab = "duel"; render();
  }
  function stop() { if (unwatch) { unwatch(); unwatch = null; } clearInterval(pollT); pollT = null; }
  function poll() {
    if (!L) return stop();
    D.get(L.id).then(function (r) {
      if (!L) return;
      if (!r) { if (L.row.status !== "done") { L.row = Object.assign({}, L.row, { status: "cancelled" }); stop(); refresh(); } return; }
      apply(r);
    }).catch(function () {});
  }
  function apply(r) {
    if (!L || r.id !== L.id || r.rev < L.row.rev) return;
    var ch = r.rev !== L.row.rev || r.status !== L.row.status;
    L.row = r;
    if (r.status === "done" && !L.paid) pay();
    if (r.status === "done") stop();
    if (ch) { vib(30); refresh(); }
  }
  function pay() {
    L.paid = true;
    var r = L.row, s = r.state || {}, win = r.winner === HV.user.id, ds = dstat();
    dmg().play++; S.played = (S.played || 0) + 1;
    L.res = { win: win, pts: 0 };
    if (win) {
      ds.lw = (ds.lw || 0) + 1;
      var d = dmg(); d.lw = d.lw || 0;
      if ((s.rd || 0) >= 2 && d.lw < 3) { d.lw++; S.pts += 15; L.res.pts = 15; }
      revealSnd(3); vib([60, 30, 60]);
    }
    save();
  }
  window.liveSup = function () { if (!L) return; L.sup = L.sup ? 0 : 1; render(); };

  /* ---------- règles (calculées par le joueur qui joue en second) ---------- */
  function resolve(s, row) {
    var h = CARDS[s.pk.h.c], g = CARDS[s.pk.g.c], sh = s.pk.h.s, sg = s.pk.g.s, ch = Math.random() < .15, cg = Math.random() < .15;
    var dh = Math.round(Math.max(5, h.atk * (sh ? 2 : 1) - Math.floor(g.def / 2)) * (ch ? 1.5 : 1));
    var dg = Math.round(Math.max(5, g.atk * (sg ? 2 : 1) - Math.floor(h.def / 2)) * (cg ? 1.5 : 1));
    s.hp.g = Math.max(0, s.hp.g - dh); s.hp.h = Math.max(0, s.hp.h - dg);
    s.u.h.push(s.pk.h.c); s.u.g.push(s.pk.g.c); s.last = { h: s.pk.h.c, g: s.pk.g.c };
    s.log.push((row.host_name || "Hôte") + " : " + (sh ? "⚡" : "") + h.name + " −" + dh + (ch ? " 💥" : "") + " · " + (row.guest_name || "Invité") + " : " + (sg ? "⚡" : "") + g.name + " −" + dg + (cg ? " 💥" : ""));
    s.pk = {}; s.rd++;
    if (s.rd >= s.n || s.hp.h <= 0 || s.hp.g <= 0) { s.end = true; s.win = s.hp.h > s.hp.g ? "h" : s.hp.g > s.hp.h ? "g" : ""; }
  }
  function patchOf(s, row) { return { state: s, status: s.end ? "done" : "playing", winner: s.end && s.win ? (s.win === "h" ? row.host : row.guest) : null }; }
  window.livePick = function (id) {
    if (!L || L.row.status !== "playing") return;
    var me = L.role, s0 = L.row.state;
    if (!s0 || (s0.pk && s0.pk[me]) || !(s0.d[me] || []).includes(id) || s0.u[me].includes(id)) return;
    var sup = L.sup; L.sup = 0;
    tone(300, .1, "triangle", .2); vib(30);
    D.mutate(L.id, function (row) {
      var s = clone(row.state);
      if (row.status !== "playing" || s.end || (s.pk && s.pk[me]) || s.u[me].includes(id)) return null;
      var use = sup && !s.sp[me]; s.pk = s.pk || {}; s.pk[me] = { c: id, s: use ? 1 : 0 }; if (use) s.sp[me] = 1;
      if (s.pk.h && s.pk.g) resolve(s, row);
      return patchOf(s, row);
    }).then(function (r) { apply(r); }).catch(function () { toast("Connexion instable, réessaie"); });
    render();
  };
  window.liveQuit = function () {
    var r = L && L.row; if (!r) { liveLeave(); return; }
    if (r.status === "open") { D.cancel(L.id).catch(function () {}); return liveLeave(); }
    if (r.status === "playing") {
      if (!confirm("Abandonner ? Ton adversaire gagne.")) return;
      var me = L.role, op = me === "h" ? "g" : "h";
      D.mutate(L.id, function (row) { if (row.status !== "playing") return null; var s = clone(row.state); s.end = true; s.win = op; s.ff = me; return patchOf(s, row); }).catch(function () {});
    }
    liveLeave();
  };
  window.liveForfeit = function () {
    var me = L.role;
    D.mutate(L.id, function (row) { if (row.status !== "playing") return null; var s = clone(row.state); s.end = true; s.win = me; s.ff = me === "h" ? "g" : "h"; return patchOf(s, row); }).then(apply).catch(function () { toast("Erreur"); });
  };
  window.liveLeave = function () { stop(); L = null; lob = null; render(); };

  /* ---------- affichage ---------- */
  function gameView() {
    var r = L.row, s = r.state || {}, me = L.role, op = me === "h" ? "g" : "h";
    var nm = function (k) { return hesc((k === "h" ? r.host_name : r.guest_name) || (k === "h" ? "Hôte" : "Invité")); };
    if (r.status === "open") return '<div class="h">Duel en direct 🌐</div><div class="pn tc"><div class="big">⏳</div><p>En attente d\'un adversaire…</p><div class="sub">Il verra ton duel dans la liste. Garde cet écran ouvert !</div><button class="btn b sbtn" onclick="liveQuit()">Annuler</button></div>';
    if (r.status === "cancelled") return '<div class="h">Duel en direct 🌐</div><div class="pn tc">Ce duel a été annulé.<button class="btn sbtn" onclick="liveLeave()">Menu</button></div>';
    var pc = function (v) { return Math.round(v / 150 * 100); }, hp = s.hp || { h: 150, g: 150 };
    var top = '<div class="pn"><div class="row"><span>Toi (' + nm(me) + ') ' + hp[me] + ' PV</span><span>' + nm(op) + ' ' + hp[op] + ' PV</span></div><div class="bar"><i style="width:' + pc(hp[me]) + '%"></i></div><br><div class="bar"><i style="width:' + pc(hp[op]) + '%;background:#ff5252"></i></div><div class="sub" style="margin-top:8px">' + (s.log || []).map(hesc).join("<br>") + '</div></div>';
    var last = s.last ? '<div class="sub tc">Dernière manche</div><div class="row" style="justify-content:space-around;gap:8px"><div style="width:42%">' + card(CARDS[s.last[me]], 1, "") + '</div><b>VS</b><div style="width:42%">' + card(CARDS[s.last[op]], 1, "") + '</div></div>' : "";
    if (r.status === "done") {
      var win = r.winner === HV.user.id, ff = s.ff ? (s.ff === me ? " (tu as abandonné)" : " (l'adversaire a abandonné)") : "";
      var msg = win ? "🏆 GG, tu as gagné !" + ff + (L.res && L.res.pts ? " +" + L.res.pts + "⭐" : "") : s.win ? "Défaite…" + ff + " revanche ? 😤" : "Égalité !";
      return '<div class="h">Duel en direct 🌐</div>' + top + last + '<div class="pn tc"><b>' + msg + '</b><button class="btn sbtn" onclick="liveLeave()">Menu</button></div>';
    }
    var mine = s.pk && s.pk[me], opp = s.pk && s.pk[op], stale = Date.now() - new Date(r.updated_at).getTime() > 90000;
    var body;
    if (mine) {
      body = '<div class="pn tc"><div class="sub">Manche ' + (s.rd + 1) + '/' + s.n + '</div><p>✅ Tu as joué <b>' + hesc(CARDS[mine.c].name) + '</b>' + (mine.s ? ' ⚡' : '') + '</p><div class="sub">En attente de ' + nm(op) + '…</div>' +
        (stale ? '<button class="btn b sbtn" onclick="liveForfeit()">Il ne répond plus : gagner par forfait</button>' : "") + '</div>';
    } else {
      body = '<div class="pn tc"><div class="sub">Manche ' + (s.rd + 1) + '/' + s.n + ' · ' + (opp ? "👍 " + nm(op) + " a joué !" : "🤔 " + nm(op) + " réfléchit…") + '</div>' +
        ((s.sp || {})[me] ? '<div class="sub">⚡ Super déjà utilisé</div>' : '<button class="btn ' + (L.sup ? "" : "b") + ' sbtn" onclick="liveSup()">⚡ Super ' + (L.sup ? "ACTIVÉ (ATK ×2)" : "(ATK ×2, 1 fois)") + '</button>') + '</div>' +
        '<div class="sub">Choisis ta carte (l\'adversaire ne la voit qu\'à la fin de la manche)</div><div class="grid">' + (s.d[me] || []).filter(function (i) { return !s.u[me].includes(i); }).map(function (i) { return card(CARDS[i], S.col[i] || 1, "pks"); }).join("") + '</div>';
    }
    return '<div class="h">Duel en direct 🌐</div>' + top + last + body + '<div class="tc"><button class="btn b sbtn" onclick="liveQuit()">🏳️ Abandonner</button></div>';
  }
})();
