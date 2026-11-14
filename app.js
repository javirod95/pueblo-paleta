/* Pueblo Paleta — lista de tareas offline-first con sincronización en Supabase.
   Todo se guarda primero en el dispositivo (localStorage) y se sincroniza
   con la tabla public.pp_tasks cuando hay conexión. */
(function () {
  'use strict';

  var CFG = window.PP_CONFIG || {};
  var SB = CFG.supabaseUrl, KEY = CFG.supabaseAnonKey;

  var CAT_LIST = ['00. JAVIER', '01. ATOCHA', '02. CIUDAD VERDE', '03. COMPRAS', '04. FAMILYLINKING', '05. AMIGOS',
    '06. FOTOS', '07. CULTURA Y FRIKERÍAS', '08. HERRAMIENTAS', '09. MÉDICOS', '10. MIS PROYECTOS', '11. VIAJES Y PLANES',
    '12. CITAS NO MÉDICAS', '13. IT', 'I. FINANZAS, BANCOS E INVERSIONES', 'II. COSAS DE CASA', 'III. FORMACIÓN',
    'IV. GESTIONES', 'V. TRABAJO', 'VI. PROYECTOS', 'Z. OTROS'];
  var PALETTE = ['#2f6fde', '#2e9d62', '#d9822b', '#8a4fd1', '#d64545', '#1aa3a3', '#c2569b', '#7a8b2c', '#b5762a', '#4f5bd5', '#5b8c5a'];
  function catColor(c) { var i = CAT_LIST.indexOf(c); return i < 0 ? '#999' : PALETTE[i % PALETTE.length]; }
  function catIdx(c) { var i = CAT_LIST.indexOf(c); return i < 0 ? 999 : i; }
  var PRIOS = { Alta: ['#c23b3b', '#fdecec'], Media: ['#a86a00', '#fdf3dc'], Baja: ['#5f6b7a', '#eef0f3'] };
  var PRIO_ORDER = { Alta: 0, Media: 1, Baja: 2 };
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var COLS = ['id', 'parent_id', 'title', 'cat', 'prio', 'date', 'done', 'deleted', 'updated_at'];
  var LS = { items: 'pp-items', dirty: 'pp-dirty', last: 'pp-last', sess: 'pp-session', owner: 'pp-owner', open: 'pp-open', hide: 'pp-hide' };

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var items = lsGet(LS.items, {});      // id -> tarea o subtarea
  var dirty = lsGet(LS.dirty, {});      // id -> true (pendiente de subir)
  var lastPull = lsGet(LS.last, null);  // server_updated_at más reciente recibido
  var session = lsGet(LS.sess, null);
  var open = lsGet(LS.open, {});
  var hideDone = lsGet(LS.hide, false);
  var sortBy = lsGet('pp-sort', 'cat');
  var filter = 'Todas', editing = null, loginError = '';
  var syncState = 'idle', syncing = false, syncAgain = false, syncTimer = null;

  function persist() { lsSet(LS.items, items); lsSet(LS.dirty, dirty); lsSet(LS.last, lastPull); }
  function nowIso() { return new Date().toISOString(); }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fdate(s) { if (!s) return 'Sin fecha'; var p = s.split('-'); return parseInt(p[2], 10) + ' ' + MESES[parseInt(p[1], 10) - 1]; }
  function cmpDone(a, b) { return !!a.done === !!b.done ? 0 : (a.done ? 1 : -1); }
  function cmpPrio(a, b) { return (PRIO_ORDER[a.prio] == null ? 9 : PRIO_ORDER[a.prio]) - (PRIO_ORDER[b.prio] == null ? 9 : PRIO_ORDER[b.prio]); }
  function cmpCat(a, b) { return catIdx(a.cat) - catIdx(b.cat); }
  function cmpDate(a, b) { var x = a.date || '9999', y = b.date || '9999'; return x < y ? -1 : x > y ? 1 : 0; }
  function cmpTitle(a, b) { return String(a.title).localeCompare(String(b.title), 'es'); }
  // Tareas: por categoría (orden de la lista) o por prioridad. Las completadas siempre al final.
  function sortTasks(a, b) {
    return cmpDone(a, b) || (sortBy === 'prio'
      ? cmpPrio(a, b) || cmpCat(a, b) || cmpDate(a, b) || cmpTitle(a, b)
      : cmpCat(a, b) || cmpPrio(a, b) || cmpDate(a, b) || cmpTitle(a, b));
  }
  // Subtareas: por prioridad y luego fecha.
  function sortSubs(a, b) { return cmpDone(a, b) || cmpPrio(a, b) || cmpDate(a, b) || cmpTitle(a, b); }


  /* ---------- Auth (API REST de Supabase, sin librerías para que funcione offline) ---------- */
  function authCall(grant, body) {
    return fetch(SB + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error_description || j.msg || j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function setSession(j) {
    session = {
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
      email: (j.user && j.user.email) || (session && session.email)
    };
    lsSet(LS.sess, session);
  }
  var refreshing = null;
  function getToken() {
    if (!session) return Promise.reject(Object.assign(new Error('Sin sesión'), { auth: true }));
    if (session.expires_at - 60 > Date.now() / 1000) return Promise.resolve(session.access_token);
    if (!refreshing) {
      refreshing = authCall('refresh_token', { refresh_token: session.refresh_token })
        .then(function (j) { setSession(j); refreshing = null; return session.access_token; },
              function (e) { refreshing = null; if (e.status >= 400 && e.status < 500) e.auth = true; throw e; });
    }
    return refreshing;
  }
  function api(path, opts) {
    opts = opts || {};
    return getToken().then(function (t) {
      var h = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, opts.headers || {});
      return fetch(SB + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (tx) { var e = new Error('HTTP ' + r.status + ' ' + tx); e.status = r.status; if (r.status === 401) e.auth = true; throw e; });
      return opts.noBody ? null : r.json();
    });
  }

  /* ---------- Sincronización ---------- */
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms == null ? 800 : ms); }
  function setSync(s) { syncState = s; renderStatus(); }

  function sync() {
    if (!session) return;
    if (syncing) { syncAgain = true; return; }
    if (navigator.onLine === false) { setSync('off'); return; }
    syncing = true; setSync('busy');
    var q = 'pp_tasks?select=*&order=server_updated_at.asc' + (lastPull ? '&server_updated_at=gt.' + encodeURIComponent(lastPull) : '');
    api(q).then(function (rows) {
      var changed = false;
      rows.forEach(function (r) {
        var loc = items[r.id];
        var keepLocal = loc && dirty[r.id] && Date.parse(loc.updated_at) > Date.parse(r.updated_at);
        if (!keepLocal) {
          var it = {}; COLS.forEach(function (c) { it[c] = r[c]; });
          items[r.id] = it; delete dirty[r.id]; changed = true;
        }
        lastPull = r.server_updated_at;
      });
      persist();
      if (changed) render();
      var ids = Object.keys(dirty).filter(function (id) { return items[id]; });
      if (!ids.length) return;
      var sent = {};
      var body = ids.map(function (id) {
        var it = items[id], o = {}; sent[id] = it.updated_at;
        COLS.forEach(function (c) { o[c] = it[c] === undefined ? null : it[c]; });
        if (!o.date) o.date = null;
        return o;
      });
      return api('pp_tasks?on_conflict=id', {
        method: 'POST', noBody: true, body: JSON.stringify(body),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
      }).then(function () {
        ids.forEach(function (id) { if (items[id] && items[id].updated_at === sent[id]) delete dirty[id]; });
        persist();
      });
    }).then(function () {
      setSync(Object.keys(dirty).length ? 'pending' : 'ok');
    }).catch(function (e) {
      if (e && e.auth) { loginError = 'Tu sesión ha caducado. Vuelve a entrar; tus cambios están guardados en este dispositivo.'; session = null; lsSet(LS.sess, null); render(); return; }
      console.warn('Sync', e);
      setSync(e instanceof TypeError || navigator.onLine === false ? 'off' : 'err');
    }).then(function () {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(100); }
    });
  }

  /* ---------- Datos ---------- */
  function tasks() { return Object.keys(items).map(function (k) { return items[k]; }).filter(function (t) { return !t.parent_id && !t.deleted; }); }
  function subsOf(id) { return Object.keys(items).map(function (k) { return items[k]; }).filter(function (s) { return s.parent_id === id && !s.deleted; }); }
  function put(it) { it.updated_at = nowIso(); items[it.id] = it; dirty[it.id] = true; }
  function commit() { persist(); render(); scheduleSync(); }

  /* ---------- Render ---------- */
  function meta(item, cat, extra) {
    var h = '';
    if (cat) h += '<span class="m"><span class="dot" style="background:' + catColor(cat) + '"></span>' + esc(cat) + '</span>';
    var p = PRIOS[item.prio] || PRIOS.Baja;
    h += '<span class="m"><span class="pill" style="color:' + p[0] + ';background:' + p[1] + '">' + esc(item.prio) + '</span></span>';
    var late = item.date && !item.done && item.date < today();
    h += '<span class="m' + (late ? ' late' : '') + '">📅 ' + fdate(item.date) + (late ? ' · vencida' : '') + '</span>';
    return h + (extra || '');
  }

  function renderLogin() {
    var hasLocal = Object.keys(items).length > 0;
    document.getElementById('app').innerHTML =
      '<div class="hero"><div class="hero-in"><div><h1>Pueblo Paleta</h1><div class="sub">Tu lista de tareas</div></div></div></div>' +
      '<form class="login" id="login"><h2>Entrar</h2><p>Usa el mismo usuario que en Ciudad Verde.</p>' +
      '<label class="f">Email</label><input name="email" type="email" autocomplete="username" required value="' + esc((session && session.email) || lsGet(LS.owner, '') || '') + '">' +
      '<label class="f">Contraseña</label><input name="pw" type="password" autocomplete="current-password" required>' +
      '<div class="err" id="lerr">' + esc(loginError) + '</div>' +
      '<div class="actions"><span class="sp"></span><button class="btn green" type="submit">Entrar</button></div>' +
      (hasLocal ? '<p style="margin-top:14px;font-size:12px">Hay tareas guardadas en este dispositivo; se sincronizarán al entrar.</p>' : '') +
      '</form>';
  }

  function render() {
    if (!session) { renderLogin(); return; }
    var all = tasks();
    var list = all.filter(function (t) { return (filter === 'Todas' || t.cat === filter) && !(hideDone && t.done); }).sort(sortTasks);
    var pending = all.filter(function (t) { return !t.done; }).length;
    var cnt = {}; all.forEach(function (t) { if (t.cat && !t.done) cnt[t.cat] = (cnt[t.cat] || 0) + 1; });
    // Solo categorías con tareas (si se ocultan las hechas, solo las que tienen pendientes).
    var has = {}; all.forEach(function (t) { if (t.cat && !(hideDone && t.done)) has[t.cat] = true; });
    var cats = CAT_LIST.filter(function (c) { return has[c]; });
    Object.keys(has).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
    if (filter !== 'Todas' && !has[filter]) { filter = 'Todas'; list = all.filter(function (t) { return !(hideDone && t.done); }).sort(sortTasks); }
    var h = '<div class="hero"><div class="hero-in"><div><h1>Pueblo Paleta</h1><div class="sub">' + pending + ' pendiente' + (pending === 1 ? '' : 's') + '</div></div>' +
      '<button class="btn light" data-act="new">+ Nueva</button></div></div><div class="wrap">';
    h += '<div class="chips"><button class="chip' + (filter === 'Todas' ? ' on' : '') + '" data-act="filter" data-v="Todas">Todas <b>' + pending + '</b></button>' +
      cats.map(function (c) { return '<button class="chip' + (c === filter ? ' on' : '') + '" data-act="filter" data-v="' + esc(c) + '"><span class="dot" style="background:' + catColor(c) + '"></span>' + esc(c) + (cnt[c] ? ' <b>' + cnt[c] + '</b>' : '') + '</button>'; }).join('') +
      '</div><div class="filters"><label class="sortby">Ordenar por <select data-act="sort">' +
      '<option value="cat"' + (sortBy === 'cat' ? ' selected' : '') + '>Categoría</option>' +
      '<option value="prio"' + (sortBy === 'prio' ? ' selected' : '') + '>Prioridad</option></select></label>' +
      '<label class="toggle"><input type="checkbox" data-act="hide"' + (hideDone ? ' checked' : '') + '> Ocultar hechas</label></div><div class="list">';
    if (!list.length) h += '<div class="empty">' + (all.length ? 'No hay tareas con este filtro.' : 'Aún no hay tareas. Pulsa “+” para crear la primera.') + '</div>';
    list.forEach(function (t) {
      var subs = subsOf(t.id).sort(sortSubs);
      var dn = subs.filter(function (s) { return s.done; }).length;
      var cnt = subs.length ? '<span class="m">☑ ' + dn + '/' + subs.length + '</span>' : '';
      h += '<div class="card' + (t.done ? ' done' : '') + (open[t.id] ? ' open' : '') + '" data-id="' + t.id + '">' +
        '<div class="card-main" data-act="expand" data-id="' + t.id + '">' +
        '<button class="check' + (t.done ? ' on' : '') + '" data-act="toggle" data-id="' + t.id + '" aria-label="Completar">' + (t.done ? '✓' : '') + '</button>' +
        '<div class="body"><div class="title">' + esc(t.title) + '</div><div class="meta">' + meta(t, t.cat, cnt) + '</div></div>' +
        '<button class="icon" data-act="edit" data-id="' + t.id + '" title="Editar">✎</button>' +
        '<button class="icon chev" data-act="expand" data-id="' + t.id + '" title="Subtareas">▾</button></div><div class="subs">';
      subs.forEach(function (s) {
        h += '<div class="sr' + (s.done ? ' done' : '') + '"><button class="check sm' + (s.done ? ' on' : '') + '" data-act="toggle" data-id="' + s.id + '">' + (s.done ? '✓' : '') + '</button>' +
          '<div class="st" data-act="edit" data-id="' + s.id + '">' + esc(s.title) + '</div><div class="meta">' + meta(s) + '</div></div>';
      });
      h += '<button class="add-sub" data-act="newsub" data-id="' + t.id + '">+ Añadir subtarea</button></div></div>';
    });
    h += '</div><p style="text-align:center;margin-top:28px"><button class="add-sub" data-act="logout">Cerrar sesión (' + esc(session.email || '') + ')</button></p></div>' +
      '<button class="fab" data-act="new" aria-label="Nueva tarea">+</button><div class="status" id="status"></div>';
    document.getElementById('app').innerHTML = h;
    renderStatus();
  }

  function renderStatus() {
    var el = document.getElementById('status'); if (!el) return;
    var n = Object.keys(dirty).length;
    var map = {
      idle: ['', 'Listo'], ok: ['ok', 'Sincronizado'], busy: ['', 'Sincronizando…'],
      pending: ['off', n + ' cambio' + (n === 1 ? '' : 's') + ' por subir'],
      off: ['off', 'Sin conexión' + (n ? ' · ' + n + ' cambio' + (n === 1 ? '' : 's') + ' guardado' + (n === 1 ? '' : 's') + ' aquí' : '')],
      err: ['err', 'Error al sincronizar · se reintentará']
    };
    var s = map[syncState] || map.idle;
    el.innerHTML = '<span class="sd ' + s[0] + '"></span>' + s[1];
  }

  /* ---------- Formulario ---------- */
  function openForm(id, parentId) {
    var it = id ? items[id] : null;
    var isSub = it ? !!it.parent_id : !!parentId;
    var parent = items[(it && it.parent_id) || parentId];
    var v = it || { title: '', cat: filter !== 'Todas' ? filter : 'Z. OTROS', prio: 'Media', date: '' };
    editing = { id: id, parentId: parentId, isSub: isSub };
    var opt = function (list, val) { return list.map(function (o) { return '<option' + (o === val ? ' selected' : '') + '>' + o + '</option>'; }).join(''); };
    var f = '<h2>' + (it ? 'Editar ' : 'Nueva ') + (isSub ? 'subtarea' : 'tarea') + (isSub && parent ? '<div class="sub">en “' + esc(parent.title) + '”</div>' : '') + '</h2>' +
      '<label class="f">Título</label><input name="title" required value="' + esc(v.title) + '" placeholder="¿Qué hay que hacer?">' +
      (isSub ? '' : '<label class="f">Categoría</label><select name="cat">' + opt(CAT_LIST, v.cat) + '</select>') +
      '<div class="row2"><div><label class="f">Prioridad</label><select name="prio">' + opt(['Alta', 'Media', 'Baja'], v.prio) + '</select></div>' +
      '<div><label class="f">Fecha</label><input type="date" name="date" value="' + esc(v.date || '') + '"></div></div>' +
      '<div class="actions">' + (it ? '<button type="button" class="btn danger" data-act="del">Eliminar</button>' : '') +
      '<span class="sp"></span><button type="button" class="btn ghost" data-act="cancel">Cancelar</button><button type="submit" class="btn green">Guardar</button></div>';
    var form = document.getElementById('form'); form.innerHTML = f;
    document.getElementById('ov').classList.add('show');
    setTimeout(function () { form.elements.title.focus(); }, 30);
  }
  function closeForm() { editing = null; document.getElementById('ov').classList.remove('show'); }

  function submitForm(form) {
    var title = form.elements.title.value.trim(); if (!title) return;
    var e = editing;
    var it = e.id ? Object.assign({}, items[e.id]) : { id: uid(), parent_id: e.isSub ? e.parentId : null, done: false, deleted: false, cat: null };
    it.title = title; it.prio = form.elements.prio.value; it.date = form.elements.date.value || null;
    if (!e.isSub) it.cat = form.elements.cat.value;
    put(it);
    if (e.isSub && !e.id) { open[e.parentId] = true; lsSet(LS.open, open); }
    closeForm(); commit();
  }
  function deleteItem(id) {
    var it = Object.assign({}, items[id]); it.deleted = true; put(it);
    if (!it.parent_id) subsOf(id).forEach(function (s) { var c = Object.assign({}, s); c.deleted = true; put(c); });
    closeForm(); commit();
  }

  /* ---------- Eventos ---------- */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, id = el.dataset.id;
    if (a === 'hide') return;
    if (a === 'filter') { var sx = document.querySelector('.chips'); var keep = sx ? sx.scrollLeft : 0; filter = el.dataset.v; render(); var nx = document.querySelector('.chips'); if (nx) nx.scrollLeft = keep; return; }
    if (a === 'new') { openForm(null, null); return; }
    if (a === 'newsub') { openForm(null, id); return; }
    if (a === 'edit') { ev.stopPropagation(); openForm(id); return; }
    if (a === 'cancel') { closeForm(); return; }
    if (a === 'del') { deleteItem(editing.id); return; }
    if (a === 'toggle') { ev.stopPropagation(); var c = Object.assign({}, items[id]); c.done = !c.done; put(c); commit(); return; }
    if (a === 'expand') {
      ev.stopPropagation(); open[id] = !open[id]; lsSet(LS.open, open);
      var card = document.querySelector('.card[data-id="' + id + '"]'); if (card) card.classList.toggle('open', !!open[id]); return;
    }
    if (a === 'logout') { session = null; lsSet(LS.sess, null); loginError = ''; render(); return; }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.dataset && ev.target.dataset.act === 'sort') { sortBy = ev.target.value; lsSet('pp-sort', sortBy); render(); return; }
    if (ev.target.dataset && ev.target.dataset.act === 'hide') { hideDone = ev.target.checked; lsSet(LS.hide, hideDone); render(); }
  });
  document.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (ev.target.id === 'form') { submitForm(ev.target); return; }
    if (ev.target.id === 'login') {
      var f = ev.target, email = f.elements.email.value.trim(), pw = f.elements.pw.value;
      var err = document.getElementById('lerr'); err.textContent = 'Entrando…';
      authCall('password', { email: email, password: pw }).then(function (j) {
        var owner = lsGet(LS.owner, null);
        if (owner && j.user && j.user.email && owner.toLowerCase() !== j.user.email.toLowerCase()) {
          items = {}; dirty = {}; lastPull = null; persist();   // otro usuario: no mezclar datos
        }
        setSession(j); lsSet(LS.owner, session.email); loginError = '';
        render(); sync();
      }).catch(function (e) {
        err.textContent = (e instanceof TypeError) ? 'Necesitas conexión para entrar la primera vez.' :
          (/invalid/i.test(e.message) ? 'Email o contraseña incorrectos.' : e.message);
      });
    }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && editing) closeForm(); });
  document.addEventListener('mousedown', function (ev) { if (ev.target.id === 'ov') closeForm(); });
  window.addEventListener('online', function () { scheduleSync(200); });
  window.addEventListener('offline', function () { setSync('off'); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') scheduleSync(200); });
  setInterval(function () { if (document.visibilityState === 'visible') sync(); }, 60000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); }); });
  }

  render();
  if (session) scheduleSync(100);
})();
