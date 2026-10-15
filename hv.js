/* Havok Cards — adaptateur Supabase (auth, synchro, contenu, outils gérant/admin) */
(function () {
  var C = window.HV_CONFIG || {};
  var HV = window.HV = { configured: false, user: null, role: "player", banned: false, pseudo: "", uidHint: null,
    content: { cards: [], boosters: [], settings: {}, loaded: false }, api: {} };
  HV.isMgr = function () { return HV.role === "manager" || HV.role === "admin"; };
  HV.isAdm = function () { return HV.role === "admin"; };
  if (!(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && window.supabase)) { HV.init = Promise.resolve(); return; }
  HV.configured = true;

  // identifiant de session lisible immédiatement (sert à isoler le cache local par compte)
  try {
    var ref = new URL(C.SUPABASE_URL).hostname.split(".")[0];
    var raw = localStorage.getItem("sb-" + ref + "-auth-token");
    if (raw) { var j = JSON.parse(raw); HV.uidHint = (j && j.user && j.user.id) || (j && j.currentSession && j.currentSession.user && j.currentSession.user.id) || null; }
  } catch (e) {}

  var sb = HV.sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  function errCode(e) { var m = (e && e.message) || ""; return (e && (e.code === "42501" || /row-level security|permission denied|not authorized/i.test(m))) ? "invalid_argument" : ((e && e.code) || "error"); }
  function wrap(p) { return Promise.resolve(p).then(function (r) { if (r && r.error) { var e = new Error(r.error.message || "erreur"); e.code = errCode(r.error); throw e; } return r ? r.data : null; }); }
  HV.wrap = wrap;

  // ---------- session & profil ----------
  function loadProfile() {
    return sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session; HV.user = s ? s.user : null;
      if (!HV.user) return;
      HV.pseudo = (HV.user.user_metadata && HV.user.user_metadata.pseudo) || "";
      return sb.from("profiles").select("role,banned").eq("id", HV.user.id).maybeSingle().then(function (p) {
        var d = p && p.data; HV.role = (d && d.role) || "player"; HV.banned = !!(d && d.banned);
      });
    });
  }
  HV.signIn = function (email, pw) { return sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) { if (r.error) throw r.error; location.reload(); }); };
  HV.signUp = function (email, pw, pseudo) {
    return sb.auth.signUp({ email: email, password: pw, options: { data: { pseudo: pseudo } } }).then(function (r) {
      if (r.error) throw r.error; if (r.data && r.data.session) { location.reload(); return "ok"; } return "confirm";
    });
  };
  HV.logout = function () { return sb.auth.signOut().then(function () { sessionStorage.removeItem("hv_guest"); location.reload(); }); };

  // ---------- contenu (cartes, boosters, réglages) ----------
  HV.loadContent = function () {
    return Promise.all([
      sb.from("cards").select("*").order("id"),
      sb.from("boosters").select("*").order("sort").order("id"),
      sb.from("settings").select("key,value")
    ]).then(function (r) {
      var st = {}; ((r[2] && r[2].data) || []).forEach(function (x) { st[x.key] = x.value; });
      HV.content = { cards: (r[0] && r[0].data) || [], boosters: (r[1] && r[1].data) || [], settings: st, loaded: true };
      if (window.applyContent) window.applyContent();
    });
  };
  HV.init = loadProfile().then(function () { return HV.loadContent().catch(function () {}); }).catch(function () {});

  // ---------- compat « claude.use » : le code de l'app parle à Supabase via ce shim ----------
  function tableOf(path) {
    var s = path.split("/");
    if (s[0] === "data" && s[1] === "users" && s[3] === "save") return { t: "saves", id: s[2] };
    return { t: s[0], id: s[1] };
  }
  function docRef(path) {
    var T = tableOf(path);
    return {
      get: function () { return sb.from(T.t).select("data").eq("user_id", T.id).maybeSingle().then(function (r) { if (r.error) { var e = new Error(r.error.message); e.code = errCode(r.error); throw e; } var d = r.data && r.data.data; return { exists: !!r.data, data: function () { return d; } }; }); },
      set: function (d) { var row = { user_id: T.id, data: d, updated_at: new Date().toISOString() }; if (T.t === "players") row.score = Math.max(0, Math.floor(+d.score || 0)); return wrap(sb.from(T.t).upsert(row, { onConflict: "user_id" })); },
      delete: function () { return wrap(sb.from(T.t).delete().eq("user_id", T.id)); }
    };
  }
  function colRef(name) {
    var q = { by: null, dir: "desc", n: 200 };
    var api = {
      orderBy: function (f, d) { q.by = f; q.dir = d || "asc"; return api; },
      limit: function (n) { q.n = n; return api; },
      onSnapshot: function (cb, errcb) {
        var timer = null, dead = false;
        function run() {
          var b = sb.from(name).select("user_id,data" + (name === "players" ? ",score" : ""));
          if (name === "players" && q.by === "score") b = b.order("score", { ascending: q.dir === "asc" });
          b.limit(q.n).then(function (r) {
            if (dead) return; if (r.error) { errcb && errcb(r.error); return; }
            cb({ docs: (r.data || []).map(function (x) { return { id: x.user_id, data: function () { return x.data; } }; }) });
          });
        }
        run();
        var ch = sb.channel("rt-" + name + "-" + Math.random().toString(36).slice(2, 7))
          .on("postgres_changes", { event: "*", schema: "public", table: name }, function () { clearTimeout(timer); timer = setTimeout(run, 400); })
          .subscribe();
        var poll = setInterval(run, 30000);
        return function () { dead = true; clearInterval(poll); try { sb.removeChannel(ch); } catch (e) {} };
      }
    };
    return api;
  }
  window.claude = {
    use: function (name) {
      return HV.init.then(function () {
        if (name === "user") return HV.user ? { id: function () { return Promise.resolve(HV.user.id); }, can: function () { return Promise.resolve(!HV.banned); } } : null;
        if (name === "db") return HV.user ? { doc: docRef, collection: colRef } : null;
        if (name === "downloads") return { save: function (o) { return new Promise(function (res) {
          var b = new Blob([o.data], { type: "application/json" }), a = document.createElement("a");
          a.href = URL.createObjectURL(b); a.download = o.filename || "sauvegarde.json"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); res(); }, 400); }); } };
        return null;
      });
    }
  };

  // ---------- API gérant / admin ----------
  var A = HV.api;
  A.uploadImage = function (blob, ext) {
    var path = HV.user.id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + (ext || "webp");
    return sb.storage.from("cards").upload(path, blob, { contentType: blob.type || "image/webp", upsert: false }).then(function (r) {
      if (r.error) throw r.error; return sb.storage.from("cards").getPublicUrl(path).data.publicUrl; });
  };
  A.createCard = function (r) { return wrap(sb.from("cards").insert(r).select().single()); };
  A.updateCard = function (id, p) { return wrap(sb.from("cards").update(p).eq("id", id).select().single()); };
  A.createBooster = function (r) { return wrap(sb.from("boosters").insert(r).select().single()); };
  A.updateBooster = function (id, p) { return wrap(sb.from("boosters").update(p).eq("id", id).select().single()); };
  A.deleteBooster = function (id) { return wrap(sb.from("boosters").delete().eq("id", id)); };
  A.setSetting = function (k, v) { return wrap(sb.from("settings").update({ value: v }).eq("key", k)); };
  A.log = function (action, detail) { return sb.from("admin_log").insert({ actor: HV.user.id, action: action, detail: detail || {} }).then(function () {}, function () {}); };
  A.listUsers = function () {
    return Promise.all([wrap(sb.from("profiles").select("id,email,role,banned,created_at")), wrap(sb.from("players").select("user_id,score,data"))]).then(function (r) {
      var m = {}; (r[1] || []).forEach(function (x) { m[x.user_id] = x; });
      return (r[0] || []).map(function (u) { var p = m[u.id], d = (p && p.data) || {};
        return { id: u.id, email: u.email, role: u.role, banned: u.banned, created_at: u.created_at, pseudo: d.pseudo || "", score: (p && p.score) || 0, uniq: d.uniq || 0, opened: d.opened || 0, wins: d.wins || 0 }; });
    });
  };
  A.setRole = function (id, role) { return wrap(sb.from("profiles").update({ role: role }).eq("id", id)); };
  A.setBanned = function (id, b) { return wrap(sb.from("profiles").update({ banned: !!b }).eq("id", id)); };
  A.grant = function (uids, pts, bonus, reason) {
    var rows = uids.map(function (u) { return { user_id: u, pts: pts | 0, bonus: bonus | 0, reason: reason || "", created_by: HV.user.id }; });
    return wrap(sb.from("grants").insert(rows));
  };
  A.myGrants = function () { return wrap(sb.from("grants").select("*").eq("user_id", HV.user.id).eq("claimed", false)); };
  A.claimGrants = function (ids) { return wrap(sb.from("grants").update({ claimed: true }).in("id", ids)); };
  A.listLog = function () { return wrap(sb.from("admin_log").select("*").order("id", { ascending: false }).limit(60)); };

  // ---------- duels en direct ----------
  var D = HV.duel = {};
  function dErr(r) { var e = new Error(r.error.message || "erreur"); e.code = errCode(r.error); return e; }
  D.get = function (id) { return wrap(sb.from("duels").select("*").eq("id", id).maybeSingle()); };
  D.open = function () {
    var since = new Date(Date.now() - 15 * 60000).toISOString();
    return wrap(sb.from("duels").select("*").eq("status", "open").is("guest", null).gt("created_at", since).order("created_at", { ascending: false }).limit(20));
  };
  D.mine = function () {
    var since = new Date(Date.now() - 30 * 60000).toISOString();
    return wrap(sb.from("duels").select("*").in("status", ["open", "playing"]).gt("updated_at", since).order("updated_at", { ascending: false }).limit(10))
      .then(function (rows) { return (rows || []).filter(function (r) { return r.host === HV.user.id || r.guest === HV.user.id; })[0] || null; });
  };
  D.create = function (name, deck) {
    return sb.from("duels").delete().eq("host", HV.user.id).eq("status", "open").then(function () {
      return wrap(sb.from("duels").insert({ host: HV.user.id, host_name: name, status: "open", state: { d: { h: deck } } }).select().single());
    });
  };
  // modification optimiste : fn(row) renvoie le patch (state, status, winner…) ou null ; réessaie si quelqu'un a modifié entre-temps
  D.mutate = function (id, fn, n) {
    n = n || 0;
    return D.get(id).then(function (row) {
      if (!row) throw new Error("gone");
      var p = fn(row); if (!p) return row;
      p.rev = row.rev + 1; p.updated_at = new Date().toISOString();
      return sb.from("duels").update(p).eq("id", id).eq("rev", row.rev).select().maybeSingle().then(function (r) {
        if (r.error) throw dErr(r);
        if (r.data) return r.data;
        if (n >= 6) throw new Error("conflit");
        return D.mutate(id, fn, n + 1);
      });
    });
  };
  D.join = function (id, name, deck) {
    return D.get(id).then(function (row) {
      if (!row || row.status !== "open" || row.guest) return null;
      var hd = (row.state && row.state.d && row.state.d.h) || [];
      var st = { d: { h: hd, g: deck }, hp: { h: 150, g: 150 }, rd: 0, n: Math.min(hd.length, deck.length), pk: {}, u: { h: [], g: [] }, sp: { h: 0, g: 0 }, log: [], end: false };
      return sb.from("duels").update({ guest: HV.user.id, guest_name: name, status: "playing", state: st, rev: row.rev + 1, updated_at: new Date().toISOString() })
        .eq("id", id).eq("status", "open").is("guest", null).select().maybeSingle().then(function (r) { if (r.error) throw dErr(r); return r.data || null; });
    });
  };
  D.cancel = function (id) { return wrap(sb.from("duels").delete().eq("id", id)); };
  D.watch = function (id, cb) {
    try {
      var ch = sb.channel("duel-" + id + "-" + Math.random().toString(36).slice(2, 6))
        .on("postgres_changes", { event: "*", schema: "public", table: "duels", filter: "id=eq." + id }, function (p) { if (p && p.new && p.new.id) cb(p.new); }).subscribe();
      return function () { try { sb.removeChannel(ch); } catch (e) {} };
    } catch (e) { return function () {}; }
  };

  // ---------- écran de connexion ----------
  HV.showAuth = function () {
    if (document.getElementById("hva")) return;
    var st = document.createElement("style");
    st.textContent = "#hva{position:fixed;inset:0;z-index:300;background:#14110d;display:flex;align-items:center;justify-content:center;padding:18px;font-family:'Lilita One',Impact,sans-serif;color:#14110d}#hva .bx{background:#fff3c9;border:4px solid #14110d;border-radius:26px;box-shadow:6px 8px 0 #ffc61a;padding:22px;width:min(100%,380px)}#hva h1{margin:0 0 4px;font-size:30px;font-weight:400;text-align:center}#hva p{margin:0 0 12px;text-align:center;opacity:.7}#hva input{width:100%;font:inherit;font-size:18px;padding:11px 12px;margin:6px 0;border:3px solid #14110d;border-radius:12px;background:#fff}#hva button{font:inherit;font-size:20px;width:100%;margin-top:10px;padding:12px;border:3px solid #14110d;border-radius:16px;background:#ffc61a;box-shadow:0 5px 0 #14110d;cursor:pointer}#hva button.g{background:transparent;border:0;box-shadow:none;font-size:16px;text-decoration:underline;margin-top:6px}#hva .tabs{display:flex;gap:8px;margin-bottom:8px}#hva .tabs button{margin:0;font-size:16px;padding:8px;background:#fff;box-shadow:none}#hva .tabs button.on{background:#ffc61a}#hva .er{color:#c62828;min-height:20px;font-size:15px;text-align:center}";
    document.head.appendChild(st);
    var d = document.createElement("div"); d.id = "hva";
    d.innerHTML = '<div class="bx"><h1>HAVOK CARDS</h1><p>Connecte-toi pour sauvegarder ta collection</p><div class="tabs"><button class="on" id="hv_t1">Connexion</button><button id="hv_t2">Créer un compte</button></div><input id="hv_ps" placeholder="Pseudo" maxlength="16" style="display:none" autocomplete="nickname"><input id="hv_em" type="email" placeholder="E-mail" autocomplete="email"><input id="hv_pw" type="password" placeholder="Mot de passe (6 caractères min.)" autocomplete="current-password"><div class="er" id="hv_er"></div><button id="hv_go">Se connecter</button><button class="g" id="hv_gu">Continuer en invité</button></div>';
    document.body.appendChild(d);
    var mode = 1, $ = function (i) { return document.getElementById(i); };
    function set(m) { mode = m; $("hv_t1").className = m == 1 ? "on" : ""; $("hv_t2").className = m == 2 ? "on" : ""; $("hv_ps").style.display = m == 2 ? "block" : "none"; $("hv_go").textContent = m == 1 ? "Se connecter" : "Créer mon compte"; $("hv_er").textContent = ""; }
    $("hv_t1").onclick = function () { set(1); }; $("hv_t2").onclick = function () { set(2); };
    $("hv_gu").onclick = function () { sessionStorage.setItem("hv_guest", "1"); d.remove(); };
    $("hv_go").onclick = function () {
      var em = $("hv_em").value.trim(), pw = $("hv_pw").value, ps = $("hv_ps").value.trim(), er = $("hv_er");
      if (!em || pw.length < 6) { er.textContent = "E-mail et mot de passe (6 car. min.) requis"; return; }
      if (mode == 2 && ps.length < 2) { er.textContent = "Choisis un pseudo (2 caractères min.)"; return; }
      er.textContent = "…";
      (mode == 1 ? HV.signIn(em, pw) : HV.signUp(em, pw, ps).then(function (x) { if (x === "confirm") er.textContent = "Compte créé : confirme ton e-mail, puis connecte-toi."; }))
        .catch(function (e) { er.textContent = (e && e.message) || "Erreur"; });
    };
  };
  HV.init.then(function () { if (!HV.user && sessionStorage.getItem("hv_guest") !== "1") { if (document.body) HV.showAuth(); else document.addEventListener("DOMContentLoaded", HV.showAuth); } });
})();
