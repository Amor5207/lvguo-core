/* 绿果统一前端（Apple TV 风格）：Web 端与 PC 端共用，按 /api/capabilities 动态开启 PC 高级能力。 */
(function () {
  'use strict';
  var $ = LV.$, $$ = LV.$$, esc = LV.esc, api = LV.api;
  var view = $('#view'), nav = $('#nav'), navbg = $('#navbg');
  var me = { loggedIn: false }, hist = [], cache = {}, cleanups = [];
  var recentPlayback = new Map(), historyRequest = 0, historyLoaded = false;
  var TTL = 90 * 1000, BOARDS = null;
  var memo = {}, pendingRestore = 0, navFresh = false, curRoute = '', hasHero = false;
  var BASE = (/^\/pc(?=\/|$)/.exec(location.pathname) || [''])[0];

  // ------------------------------------------------------------ 小工具
  function remember(list) { (list || []).forEach(function (s) { var id = s.id || s.seriesId; if (id) cache[id] = Object.assign(cache[id] || {}, s); }); }
  function cleanup() { cleanups.splice(0).forEach(function (f) { try { f(); } catch (e) {} }); }
  function hasNativeIpc() { return !!(window.ipc && typeof window.ipc.postMessage === 'function'); }
  function sendWinAction(action) {
    if (hasNativeIpc()) {
      try { window.ipc.postMessage(JSON.stringify({ type: 'win', action: action })); return true; } catch (e) { return false; }
    }
    if (action === 'close') {
      try { window.close(); } catch (e) {}
      if (isStandalonePlay()) {
        setTimeout(function () { if (history.length > 1) history.back(); else go('/'); }, 60);
      }
      return true;
    }
    return false;
  }
  (function () {
    var tb = $('#topbar');
    if (!tb) return;
    tb.addEventListener('click', function (e) {
      var b = e.target.closest('[data-win]');
      if (b) { e.stopPropagation(); sendWinAction(b.dataset.win); }
    });
    tb.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !LV.caps || !LV.caps.customTitlebar) return;
      if (e.target.closest('input,button,a,form,#topSuggest,[data-win]')) return;
      sendWinAction('drag');
    });
    tb.addEventListener('dblclick', function (e) {
      if (!LV.caps || !LV.caps.customTitlebar) return;
      if (e.target.closest('input,button,a,form,#topSuggest,[data-win]')) return;
      sendWinAction('maximize');
    });
  })();
  function brandName() { return (LV.caps && LV.caps.desktop) ? '绿果PC' : '绿果WEB'; }
  function title(t) { document.title = t ? t + ' - ' + brandName() : brandName(); }
  function mount(h) { view.innerHTML = '<div class="page">' + h + '</div>'; return view.firstChild; }
  function head(t, sub) { return '<div class="ph"><h1 class="lt">' + t + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>'; }
  function empty(icon, h, sub, btn) { return '<div class="empty"><i>' + ic(icon) + '</i><b>' + esc(h) + '</b>' + (sub ? '<div>' + esc(sub) + '</div>' : '') + (btn || '') + '</div>'; }
  function failed(msg) { return empty('refresh', '加载失败', msg, '<button class="btn primary" data-retry>' + ic('refresh') + '重试</button>'); }
  function cats(s, n) { return (s.category || '').split(',').filter(Boolean).slice(0, n || 2); }
  function playsShort(n) { return LV.plays(n).replace('次播放', ''); }
  function hl(text, q) {
    text = esc(text); if (!q) return text;
    var e = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('(' + e + ')', 'ig'), '<mark>$1</mark>');
  }
  // 取榜单前 want 部：第一页常常很少，最多再翻 3 页
  async function boardItems(id, want) {
    var list = [], seen = {}, off = 0, sess = '';
    for (var k = 0; k < 4 && list.length < want; k++) {
      var r = await api('/api/rank', { query: { board: id, offset: off, session: sess }, ttl: TTL });
      r.items.forEach(function (s) { if (!seen[s.id] && list.length < want) { seen[s.id] = 1; list.push(s); } });
      if (!r.more || !r.items.length) break; off = r.next; sess = r.session;
    }
    remember(list); return list;
  }
  async function boards() { if (!BOARDS) BOARDS = (await api('/api/category/options', { query: { type: 'all' }, ttl: 600000 })).boards; return BOARDS; }

  // ------------------------------------------------------------ 组件
  function card(s, o) {
    o = o || {}; var id = s.id || s.seriesId, eps = s.episodes || s.episodeCount;
    return '<button class="card' + (o.i != null ? ' rise' : '') + '"' + (o.i != null ? ' style="--i:' + Math.min(o.i, 17) + '"' : '') + ' data-id="' + id + '"><div class="poster">' + LV.img(s.cover, s.title, o.w || 360) +
      (o.rank ? '<span class="rk' + (o.rank <= 3 ? ' top' : '') + '">' + o.rank + '</span>' : '') +
      (eps && !o.nobadge ? '<span class="badge">' + eps + '集</span>' : '') + (o.x ? '<span class="x" data-x="' + o.x + '" title="移除">' + ic('close') + '</span>' : '') + '</div>' +
      '<div class="t">' + (o.th || esc(s.title)) + '</div>' + (o.sub ? '<div class="s">' + esc(o.sub) + '</div>' : '') + '</button>';
  }
  function cardSk(n) { return Array.from({ length: n }, function () { return '<div class="card sk"><div class="poster skel"></div><div class="t skel"></div></div>'; }).join(''); }
  function gridCols() {
    var g = $('.grid');
    var n = parseInt(getComputedStyle(g || document.documentElement).getPropertyValue('--n'), 10);
    if (n > 0) return n;
    return innerWidth <= 760 ? 3 : innerWidth <= 1366 ? 5 : innerWidth >= 2000 ? 8 : innerWidth >= 1680 ? 7 : 6;
  }
  function gridSk(rows) { return cardSk(gridCols() * (rows || 2)); }
  function cwCard(c, i, del) {
    var pr = c.episodeCount ? Math.min(1, (c.episodeIndex + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
    return '<button class="cw" data-cw="' + c.seriesId + '"><div class="bgx">' + LV.img(c.cover, '', 200) + '</div><div class="pp">' + LV.img(c.cover, c.title, 240) + '</div>' +
      '<div class="info"><b>' + esc(c.title) + '</b><span>第 ' + (c.episodeIndex + 1) + ' 集' + (c.episodeCount ? ' / 共 ' + c.episodeCount + ' 集' : '') + ' · ' + LV.ago(c.time) + '</span><div class="pb"><i style="width:' + pr * 100 + '%"></i></div></div>' +
      '<span class="go">' + ic('play2') + '</span>' + (del ? '<span class="del" data-x="history" title="删除记录">' + ic('close') + '</span>' : '') + '</button>';
  }
  function cwSk(n) { return Array.from({ length: n }, function () { return '<div class="cw sk skel"></div>'; }).join(''); }
  function cwRich(c, count) {
    var pr = c.episodeCount ? Math.min(1, (c.episodeIndex + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
    var pctText = c.episodeCount ? Math.round(pr * 100) + '%' : '';
    var seenSec = Math.floor((c.positionMs || 0) / 1000);
    var posHint = seenSec > 0 ? '已看 ' + LV.time(seenSec) : '刚开始播放';
    var known = cache[c.seriesId] || {};
    var catList = cats(known, 3);
    var metaBits = ['第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' / 共 ' + c.episodeCount + ' 集' : ''), posHint, LV.ago(c.time)].concat(catList).filter(Boolean);
    var introTxt = known.intro || '';
    if (count === 1) {
      return '<div class="cw-rich spot" data-cw-card="' + c.seriesId + '" data-cw="' + c.seriesId + '">' +
        '<div class="cw-bg" style="background-image:url(\'' + esc(LV.sized(c.cover, 200)) + '\')"></div>' +
        '<div class="cw-scrim"></div>' +
        '<div class="cw-poster">' + LV.img(c.cover, c.title, 400) + '</div>' +
        '<div class="cw-body">' +
        '<div class="cw-kick"><i></i><span>继续观看</span>' + (pctText ? '<em class="cw-pct">已看 ' + pctText + '</em>' : '') + '</div>' +
        '<div class="cw-top"><b>' + esc(c.title) + '</b></div>' +
        '<div class="cw-pills" data-cw-pills>' + metaBits.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' +
        '<p class="cw-intro' + (introTxt ? '' : ' empty') + '" data-cw-intro>' + esc(introTxt || '点击继续从上次断点无缝接续观看，或查看全部分集与剧集简介') + '</p>' +
        '<div class="cw-foot">' +
        '<div class="cw-prog"><div class="cw-pb"><i style="width:' + (pr * 100) + '%"></i></div></div>' +
        '<div class="cw-acts"><button type="button" class="btn primary" data-play="' + c.seriesId + '">' + ic('play2') + '<span>继续播放 第 ' + ((c.episodeIndex || 0) + 1) + ' 集</span></button>' +
        '<button type="button" class="btn glass" data-info="' + c.seriesId + '"><span>剧集详情</span>' + ic('chev') + '</button></div>' +
        '</div></div></div>';
    }
    return '<div class="cw-rich" data-cw-card="' + c.seriesId + '" data-cw="' + c.seriesId + '">' +
      '<div class="cw-bg" style="background-image:url(\'' + esc(LV.sized(c.cover, 200)) + '\')"></div>' +
      '<div class="cw-poster">' + LV.img(c.cover, c.title, 360) + '</div>' +
      '<div class="cw-body">' +
      '<div class="cw-top"><b>' + esc(c.title) + '</b><small>' + LV.ago(c.time) + '</small></div>' +
      '<div class="cw-sub">第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' / 共 ' + c.episodeCount + ' 集' : '') + ' · ' + posHint + (pctText ? ' · ' + pctText : '') + '</div>' +
      (introTxt ? '<p class="cw-intro" data-cw-intro>' + esc(introTxt) + '</p>' : '<p class="cw-intro empty" data-cw-intro></p>') +
      '<div class="cw-pb"><i style="width:' + (pr * 100) + '%"></i></div>' +
      '</div>' +
      '<button type="button" class="cw-go" data-play="' + c.seriesId + '" aria-label="继续播放">' + ic('play2') + '</button>' +
      '</div>';
  }
  // 继续观看 / 本机记录的小卡（TV 风：小海报 + 进度条），点卡续播（data-cw）
  function cwMini(c, i, del) {
    var pr = c.episodeCount ? Math.min(1, (c.episodeIndex + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
    return '<button class="card rise" style="--i:' + Math.min(i, 17) + '" data-cw="' + c.seriesId + '"><div class="poster">' + LV.img(c.cover, c.title, 360) +
      '<div class="cwpb"><i style="width:' + pr * 100 + '%"></i></div>' +
      (del ? '<span class="x" data-x="history" title="移除记录">' + ic('close') + '</span>' : '') + '</div>' +
      '<div class="t">' + esc(c.title) + '</div><div class="s">看到第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' / 共 ' + c.episodeCount + ' 集' : '') + '</div></button>';
  }
  function crRow(s, no, i) {
    var meta = [s.episodes ? '全 ' + s.episodes + ' 集' : '', LV.plays(s.plays)].concat(cats(s, 2)).filter(Boolean).join(' · ');
    return '<button class="cr" data-id="' + s.id + '"><span class="rn">' + no + '</span><div class="poster">' + LV.img(s.cover, s.title, 160) + '</div><div class="ri"><b>' + esc(s.title) + '</b><span>' + esc(meta) + '</span></div><span class="go" data-play="' + s.id + '">' + ic('play2') + '</span></button>';
  }
  function crSk(n) { return Array.from({ length: n }, function () { return '<div class="cr sk"><span class="rn"></span><div class="poster skel"></div><div class="ri"><div class="skel t m"></div><div class="skel t s"></div></div></div>'; }).join(''); }
  function arrows() { return '<button class="arr l off" data-arr="-1" aria-label="向左">' + ic('back') + '</button><button class="arr r" data-arr="1" aria-label="向右">' + ic('chev') + '</button>'; }
  function shelf(t, more, cls, inner, attrs) {
    return '<section class="shelf"' + (attrs || '') + '><div class="sh"><h2>' + t + '</h2>' + (more ? '<a class="more" href="' + more + '">查看全部' + ic('chev') + '</a>' : '') + '</div>' + arrows() + '<div class="row ' + (cls || '') + '">' + inner + '</div></section>';
  }
  function seg(items, cur, attr) { return '<div class="seg"><i class="th"></i>' + items.map(function (x) { return '<button ' + attr + '="' + x[0] + '" class="' + (x[0] === cur ? 'on' : '') + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>'; }
  function placeSeg(root) {
    $$('.seg', root || document).forEach(function (s) {
      var b = $('button.on', s), t = $('.th', s); if (!b || !t || !s.offsetParent) return;
      var first = !t.classList.contains('show');
      if (first) t.style.transition = 'none';
      t.style.width = b.offsetWidth + 'px'; t.style.transform = 'translateX(' + b.offsetLeft + 'px)'; t.classList.add('show');
      if (first) { void t.offsetWidth; t.style.transition = ''; }
    });
  }
  // 货架箭头：随滚动位置启用/禁用；点击翻一页
  function arrState(row) {
    var sec = row.closest('.shelf'); if (!sec || !$('.arr', sec)) return;
    var max = row.scrollWidth - row.clientWidth - 4;
    $('.arr.l', sec).classList.toggle('off', row.scrollLeft <= 4);
    $('.arr.r', sec).classList.toggle('off', row.scrollLeft >= max);
  }
  var arrT = 0;
  document.addEventListener('scroll', function (e) { var t = e.target; if (t.classList && t.classList.contains('row')) { cancelAnimationFrame(arrT); arrT = requestAnimationFrame(function () { arrState(t); }); } }, true);
  // 翻一页：按卡片宽度对齐，ease-in-out 600ms；动画期间关吸附，结束后恢复
  function glide(row, dir) {
    if (row._g) cancelAnimationFrame(row._g);
    var c = row.children[1] ? row.children[1].offsetLeft - row.children[0].offsetLeft : row.clientWidth;
    var per = Math.max(1, Math.floor((row.clientWidth - 80) / c));
    var from = row.scrollLeft, max = row.scrollWidth - row.clientWidth;
    var to = Math.max(0, Math.min(max, Math.round(from / c + dir * per) * c));
    if (to === from) return;
    var t0 = performance.now(), D = 620;
    row.style.scrollSnapType = 'none';
    (function step(t) {
      var k = Math.min(1, (t - t0) / D), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      row.scrollLeft = from + (to - from) * e;
      if (k < 1) row._g = requestAnimationFrame(step); else { row._g = 0; row.style.scrollSnapType = ''; arrState(row); }
    })(t0);
  }
  // 鼠标按住拖动横向滚动（触控板本来就能横滑）；拖动过就吞掉这次点击
  (function () {
    var drag = null;
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      var row = e.target.closest('.row'); if (!row || e.target.closest('.arr')) return;
      drag = { row: row, x: e.clientX, left: row.scrollLeft, moved: false, id: e.pointerId };
    });
    document.addEventListener('pointermove', function (e) {
      if (!drag) return; var dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; drag.row.classList.add('dragging'); drag.row.style.scrollSnapType = 'none'; }
      if (drag.moved) { drag.row.scrollLeft = drag.left - dx; e.preventDefault(); }
    });
    document.addEventListener('pointerup', function () {
      if (!drag) return; var d = drag; drag = null;
      if (d.moved) {
        d.row.classList.remove('dragging');
        var c = d.row.children[1] ? d.row.children[1].offsetLeft - d.row.children[0].offsetLeft : 1;
        var to = Math.round(d.row.scrollLeft / c) * c;
        d.row.scrollTo({ left: to, behavior: 'smooth' }); setTimeout(function () { d.row.style.scrollSnapType = ''; arrState(d.row); }, 400);
        var stop = function (ev) { ev.stopPropagation(); ev.preventDefault(); }; window.addEventListener('click', stop, { capture: true, once: true }); setTimeout(function () { window.removeEventListener('click', stop, true); }, 50);
      }
    });
    document.addEventListener('dragstart', function (e) { if (e.target.closest && e.target.closest('.row')) e.preventDefault(); });
  })();
  function rowsReady(root) { $$('.row', root).forEach(arrState); }
  window.addEventListener('resize', LV.debounce(function () { rowsReady(view); placeSeg(); setTab(curTab); }, 120));

  // ------------------------------------------------------------ 导航
  var tabs = $('#tabs'), hlb = $('.hl', tabs), curTab = '';
  function setTab(name) {
    curTab = name; var a = null;
    $$('a', tabs).forEach(function (x) { var on = x.dataset.tab === name; x.classList.toggle('on', on); if (on) a = x; });
    if (!a) return hlb.classList.remove('show');
    var first = !hlb.classList.contains('show');
    if (first) hlb.style.transition = 'none';
    hlb.style.width = a.offsetWidth + 'px'; hlb.style.transform = 'translateX(' + a.offsetLeft + 'px)'; hlb.classList.add('show');
    if (first) { void hlb.offsetWidth; hlb.style.transition = ''; }
  }
  // 首页始终显示导航背景，其他页面在滚动后显示。
  var scT = 0;
  function onScroll() {
    scT = 0; var y = window.scrollY, hero = $('.hero', view), heroH = hero ? hero.offsetHeight : 0;
    var over = hasHero && y < heroH - nav.offsetHeight;
    nav.classList.toggle('over', over);
    nav.classList.toggle('solid', !over && y > 4); navbg.classList.toggle('on', curTab === 'home' || curTab === 'feed' || y > 4);
    var b2 = $('.bar2', view), stuck = !!b2 && b2.getBoundingClientRect().top <= nav.offsetHeight + 1;
    if (b2) b2.classList.toggle('stuck', stuck);
  }
  window.addEventListener('scroll', function () { if (!scT) scT = requestAnimationFrame(onScroll); }, { passive: true });

  function renderAcct() {
    var b = $('#acct');
    if (!b) return;
    if (LV.loggedIn && me.profile) {
      var p = me.profile;
      b.innerHTML = '<span class="sb-av">' + (p.avatar ? LV.img(p.avatar, '', 120, true) : '') + '<em>' + esc((p.name || '绿')[0]) + '</em></span>' +
        '<span class="sb-meta"><b>' + esc(p.name || '红果用户') + '</b><small>' + (me.daysLeft >= 0 ? '有效期 ' + me.daysLeft + ' 天' : '已登录 · 数据同步中') + '</small></span>' +
        '<span class="sb-act danger">退出</span>';
      b.title = (p.name || '账号') + ' · 点击退出登录';
    } else {
      b.innerHTML = '<span class="sb-av guest">' + ic('user') + '</span>' +
        '<span class="sb-meta"><b>未登录</b><small>登录以同步数据</small></span>' +
        '<span class="sb-act primary">登录</span>';
      b.title = '登录（可选）';
    }
  }
  function closeMenu() { var m = $('.menu'); if (m) m.remove(); }
  $('#acct').onclick = function (e) {
    e.stopPropagation();
    if (!LV.loggedIn) return showLogin();
    logout();
  };
  async function logout() {
    if (!(await confirmBox('退出登录？', '退出后需重新登录红果账号。', '退出登录', true))) return;
    try { await api('/api/logout', { body: {} }); } catch (e) {}
    persist('me', { loggedIn: false }, 7 * 86400e3); persist('hist', [], 7 * 86400e3);
    location.reload();
  }
  document.addEventListener('keydown', function (e) {
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !PL) {
      e.preventDefault(); openSearch();
    }
  });

  // ------------------------------------------------------------ 路由（HTML5 History）
  var hops = 0;
  function stripBase(p) { return p.replace(/^\/pc(?=\/|$)/, '') || '/'; }
  function currentURL() { return stripBase(location.pathname) + location.search; }
  function fullPath(url) { return BASE ? BASE + (url === '/' ? '' : url) : url; }
  function isAppPath(p) {
    return /^\/(?:pc(?:\/|$))?(?:$|home$|feed$|rank$|category$|mine(?:\/(?:history|fav|reserve))?$|detail\/\d+$|play$|downloads$|settings$|search$)/.test(p);
  }
  function isStandalonePlay() { return stripBase(location.pathname) === '/play'; }
  function isHomePath() { return /^\/(?:home)?$/.test(stripBase(location.pathname)); }
  function go(url, replace) {
    var clean = stripBase(url);
    var target = fullPath(clean);
    if (clean === currentURL() && curRoute) return;
    navFresh = true;
    if (replace) history.replaceState(null, '', target);
    else { hops++; history.pushState(null, '', target); }
    window.dispatchEvent(new CustomEvent('lv:nav'));
    LV.vt(function () { route(); });
  }
  function quietURL(url) {
    var clean = stripBase(url);
    var target = fullPath(clean);
    if (currentURL() === clean) return;
    history.replaceState(history.state, '', target);
    curRoute = clean;
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (er) { return; }
    if (url.origin !== location.origin || !isAppPath(url.pathname)) return;
    e.preventDefault();
    go(url.pathname + url.search);
  });
  view.addEventListener('click', function (e) { if (e.target.closest('[data-back]')) { if (hops > 0) history.back(); else go('/'); } });
  window.addEventListener('popstate', function () {
    var next = currentURL();
    if (next === curRoute) return;
    hops++;
    LV.vt(function () { route(); });
  });
  window.addEventListener('hashchange', function () {
    if (location.hash.indexOf('#/') === 0) go(location.hash.slice(1), true);
  });
  var restoring = 0;
  function ready() {
    var y = pendingRestore; pendingRestore = 0; if (!y) return;
    var token = ++restoring, tries = 0, stop = false;
    function halt() { stop = true; }
    ['wheel', 'keydown', 'mousedown'].forEach(function (ev) { window.addEventListener(ev, halt, { once: true, passive: true }); });
    (function step() { if (stop || token !== restoring) return; window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 4 && tries++ < 40) setTimeout(step, 120); })();
  }
  function route() {
    if (location.hash.indexOf('#/') === 0) history.replaceState(null, '', fullPath(location.hash.slice(1)));
    if (curRoute) memo[curRoute] = window.scrollY;
    curRoute = currentURL();
    pendingRestore = navFresh ? 0 : (memo[curRoute] || 0); navFresh = false;
    cleanup(); closeMenu(); closeSearch(); hasHero = false;
    if (!pendingRestore) window.scrollTo(0, 0);
    var p = stripBase(location.pathname), m;
    if (p === '/play') {
      document.body.dataset.route = 'play';
      document.documentElement.setAttribute('data-standalone', '1');
      setTab('');
      openStandalonePlay();
      return;
    }
    document.documentElement.removeAttribute('data-standalone');
    if ((m = p.match(/^\/detail\/(\d+)$/))) { document.body.dataset.route = 'detail'; setTab(''); detail(m[1]); }
    else if (/^\/search$/.test(p)) {
      document.body.dataset.route = 'search';
      var sq = new URLSearchParams(location.search).get('q') || '';
      setTab('search');
      searchPage(sq);
    }
    else if (/^\/downloads$/.test(p)) {
      document.body.dataset.route = 'downloads';
      if (!LV.caps.download) {
        title('离线下载');
        setTab('');
        mount(empty('download', '仅支持绿果 PC 客户端', '离线下载管理功能仅在绿果 PC 桌面端开放', '<a class="btn primary" href="/">返回首页</a>'));
      } else {
        setTab('downloads');
        downloadsPage();
      }
    }
    else if (/^\/settings$/.test(p)) { document.body.dataset.route = 'settings'; setTab('settings'); settings(); }
    else if ((m = p.match(/^\/mine\/(history|fav|reserve)$/))) { document.body.dataset.route = 'mine'; setTab(m[1]); mine(m[1]); }
    else {
      var n = (p.match(/^\/(\w+)/) || [])[1] || 'home';
      if (['home', 'feed', 'rank', 'category', 'mine'].indexOf(n) < 0) n = 'home';
      document.body.dataset.route = n;
      setTab(n === 'mine' ? 'history' : n); ({ home: home, feed: feedPage, rank: rank, category: category, mine: mine })[n]();
    }
    onScroll();
  }

  // ------------------------------------------------------------ 全局点击
  function openDetail(id, from) {
    $$('.poster,.pp,.th,.art').forEach(function (n) { if (n.style.viewTransitionName) n.style.viewTransitionName = ''; });
    var p = from && from.querySelector('.poster, .pp'); if (p) p.style.viewTransitionName = 'cover';
    go('/detail/' + id);
  }
  view.addEventListener('click', function (e) {
    var x = e.target.closest('[data-x]'); if (x) { e.stopPropagation(); return removeItem(x); }
    var a = e.target.closest('.arr'); if (a) { var row = $('.row', a.closest('.shelf')); return glide(row, +a.dataset.arr); }
    if (e.target.closest('[data-retry]')) return route();
    if (e.target.closest('[data-login]')) return showLogin();
    var pl = e.target.closest('[data-play]'); if (pl) { e.stopPropagation(); return playSeries(pl.dataset.play); }
    var inf = e.target.closest('[data-info]'); if (inf) return openDetail(inf.dataset.info);
    var cw = e.target.closest('[data-cw]'); if (cw) return playSeries(cw.dataset.cw);
    var sn = e.target.closest('[data-soon]'); if (sn) return soonPopup(sn.dataset.soon);
    var el = e.target.closest('[data-id]'); if (el) openDetail(el.dataset.id, el);
  });
  // 悬停预取详情与播放源：点开时数据已在缓存里
  var warmT = 0;
  view.addEventListener('pointerover', function (e) {
    var c = e.target.closest('[data-id],[data-cw],[data-play]'); if (!c || c.contains(e.relatedTarget)) return;
    clearTimeout(warmT); var id = c.dataset.id || c.dataset.cw || c.dataset.play, isDirect = !!(c.dataset.cw || c.dataset.play);
    warmT = setTimeout(function () {
      if (PL || OPENING) return;
      var p = progressOf(id), lite = (isDirect && (historyLoaded || p)) ? '1' : undefined;
      api('/api/detail', { query: { id: id, lite: lite }, ttl: TTL }).catch(function () {});
      var vid = (p && p.vid) || (cache[id] && cache[id].firstVid) || '';
      if (vid) playInfo(vid, LV.get('quality')).catch(function () {});
    }, 120);
  });
  function saveCachedHist() {
    persist('hist', hist.slice(0, 24), 7 * 86400e3);
  }
  function mergeRecentHistory(cloud) {
    var by = new Map(); (cloud || []).forEach(function (e) { if (e && e.seriesId && (!by.has(e.seriesId) || (e.time || 0) >= (by.get(e.seriesId).time || 0))) by.set(e.seriesId, e); });
    recentPlayback.forEach(function (e, id) {
      var c = by.get(id);
      if (Date.now() - (e.time || 0) >= 120000 || (c && (c.time || 0) >= (e.time || 0))) recentPlayback.delete(id);
      else by.set(id, e);
    });
    return Array.from(by.values()).sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
  }
  async function loadHistory(fresh) { var request = ++historyRequest; try { var rows = (await api(fresh === true ? '/api/history?fresh=1' : '/api/history')).items || []; if (request !== historyRequest) return hist; hist = mergeRecentHistory(rows); historyLoaded = true; saveCachedHist(); window.dispatchEvent(new CustomEvent('lv:history', { detail: hist })); } catch (e) {} return hist; }
  function progressOf(id) { return hist.find(function (h) { return h.seriesId === id; }); }
  function latestProgress(id, supplied) { var local = progressOf(id); return local && (!supplied || (local.time || 0) >= (supplied.time || 0)) ? local : supplied; }
  function playSeries(id) { openSeriesLoader(id); }

  // ------------------------------------------------------------ 主视觉
  function metaHtml(s) {
    var m = [];
    if (s.rating) m.push('<span class="star">★ ' + esc(s.rating) + '</span>');
    if (s.tag) m.push('<span class="pill">' + esc(s.tag) + '</span>');
    var n = s.episodes || s.count;
    return m.concat([n ? '全 ' + n + ' 集' : '', s.plays ? playsShort(s.plays) + ' 次播放' : ''].concat(cats(s, 3)).filter(Boolean).map(esc)).join('<span class="dot"></span>');
  }
  function slide(s, on, kick, eager, acts) {
    return '<div class="hs' + (on ? ' on' : '') + '"><div class="bg" style="background-image:url(\'' + esc(LV.sized(s.cover, 24)) + '\')"></div><div class="art" data-info="' + s.id + '">' + LV.img(s.cover, s.title, 900, eager) + '</div><div class="scrim"></div>' +
      '<div class="txt"><div class="kick"><i></i>' + kick + '</div><div class="ttl">' + esc(s.title) + '</div><div class="meta">' + metaHtml(s) + '</div>' +
      '<p class="intro">' + esc(s.intro || '') + '</p><div class="acts">' + (acts || '<button class="bplay" data-play="' + s.id + '">' + ic('play2') + '播放</button><button class="bglass" data-info="' + s.id + '">详情' + ic('chev') + '</button>') + '</div></div></div>';
  }
  function heroSkTxt() { return '<div class="hs on"><div class="txt"><div class="skel" style="position:relative;width:96px;height:14px"></div><div class="skel" style="position:relative;width:78%;height:54px;margin-top:22px"></div><div class="skel" style="position:relative;width:52%;height:54px;margin-top:12px"></div><div class="skel" style="position:relative;width:60%;height:16px;margin-top:26px"></div><div class="skel" style="position:relative;width:200px;height:52px;margin-top:30px;border-radius:99px"></div></div></div>'; }

  // ------------------------------------------------------------ 首页
  var HOME_BOARD = 'ranklist_hot_play_sc';
  var HERO_BOARD = 'ranklist_hot_sc';
  // 本地持久缓存：再次打开时先用上次的内容立即渲染，新数据后台拉取（不打断已显示的内容）
  function persist(k, v, maxAge) {
    try { if (v !== undefined) localStorage.setItem('lvguo.c.' + k, JSON.stringify({ t: Date.now(), v: v })); else { var o = JSON.parse(localStorage.getItem('lvguo.c.' + k) || 'null'); return o && Date.now() - o.t < (maxAge || 3 * 86400e3) ? o.v : null; } } catch (e) { return null; }
  }
  function slim(s) { return { id: s.id, title: s.title, cover: s.cover, intro: s.intro, episodes: s.episodes, plays: s.plays, category: s.category, firstVid: s.firstVid }; }
  function renderHero(hero, picks) {
    hero.classList.add('wait');
    var arrows = picks.length > 1
      ? '<button class="harrow hprev" type="button" data-hdir="-1" aria-label="上一张">' + ic('back') + '</button>' +
        '<button class="harrow hnext" type="button" data-hdir="1" aria-label="下一张">' + ic('chev') + '</button>'
      : '';
    hero.innerHTML = picks.map(function (s, i) { return slide(s, !i, '推荐榜', true); }).join('') + arrows +
      '<div class="hnav">' + picks.map(function (_, i) { return '<button class="' + (i ? '' : 'on') + '" data-b="' + i + '" aria-label="第 ' + (i + 1) + ' 张"><i></i></button>'; }).join('') + '</div>';
    // 等首张封面（缩略图或大图）到了再淡入，避免先出空底 + 文字
    var done = false, reveal = function () { if (done) return; done = true; requestAnimationFrame(function () { hero.classList.remove('wait'); }); };
    [LV.sized(picks[0].cover, 24), LV.sized(picks[0].cover, 900)].forEach(function (u) { var im = new Image(); im.referrerPolicy = 'no-referrer'; im.onload = reveal; im.onerror = reveal; im.src = u; });
    setTimeout(reveal, 1200);
    picks.slice(1).forEach(function (s) { var im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = LV.sized(s.cover, 900); });
  }
  function heroCarousel(hero, picks) {
    var n = picks.length;
    var cur = 0, timer = 0, hold = false, seen = true, prevTimer = 0;
    function sl() { return $$('.hs', hero); }
    function arm() { clearTimeout(timer); timer = setTimeout(function () { if (!hold && seen && !PL && document.visibilityState === 'visible') show(cur + 1, 1); else arm(); }, 8000); }
    function show(i, forceDir) {
      var nx = (i + n) % n; if (nx === cur) return arm();
      var old = cur, dir = forceDir || (i < cur ? -1 : 1); hero.style.setProperty('--dir', dir);
      cur = nx;
      clearTimeout(prevTimer);
      hero.classList.add('sliding');
      sl().forEach(function (s, k) {
        s.classList.remove('prev', 'on');
        if (k === old && old !== cur) { void s.offsetWidth; s.classList.add('prev'); }
        else if (k === cur) { void s.offsetWidth; s.classList.add('on'); }
      });
      prevTimer = setTimeout(function () {
        sl().forEach(function (s) { s.classList.remove('prev'); });
        hero.classList.remove('sliding');
      }, 650);
      $$('.hnav button', hero).forEach(function (b, k) { b.classList.remove('on'); if (k === cur) { void b.offsetWidth; b.classList.add('on'); } });
      arm();
    }
    arm();
    hero.addEventListener('click', function (e) {
      var hdir = e.target.closest('[data-hdir]');
      if (hdir) { e.stopPropagation(); var d = +hdir.dataset.hdir; show(cur + d, d); return; }
      var ddot = e.target.closest('[data-b]');
      if (ddot && +ddot.dataset.b !== cur) { var ni = +ddot.dataset.b; show(ni, ni > cur ? 1 : -1); }
    });
    hero.addEventListener('mouseover', function (e) { if (e.target.closest('.txt,.hnav,.harrow')) { hold = true; hero.classList.add('hold'); } });
    hero.addEventListener('mouseout', function (e) { if (e.target.closest('.txt,.hnav,.harrow') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.txt,.hnav,.harrow'))) { hold = false; hero.classList.remove('hold'); arm(); } });
    var hio = new IntersectionObserver(function (es) { seen = es[0].isIntersecting; }, { threshold: 0.35 }); hio.observe(hero);
    function keys(e) { if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || PL || window.scrollY > 200) return; if (e.key === 'ArrowLeft') show(cur - 1, -1); else if (e.key === 'ArrowRight') show(cur + 1, 1); }
    document.addEventListener('keydown', keys);
    cleanups.push(function () { clearTimeout(timer); clearTimeout(prevTimer); hio.disconnect(); document.removeEventListener('keydown', keys); });
  }
  async function home() {
    title(''); hasHero = false;
    var cached = persist('home'), cachedHero = persist('hero.' + HERO_BOARD, undefined, 7 * 86400e3);
    var root = mount('<section class="hero">' + heroSkTxt() + '</section><div class="shelves"><div id="cont"></div>' +
      shelf('热播榜', '/rank?board=' + HOME_BOARD, '', cardSk(Math.max(10, gridCols() * 2)), ' id="hot"') +
      '<section class="shelf"><div class="sh"><h2>为你推荐</h2><div class="fych" id="fych"></div><button class="fy-swap" id="fy-swap" type="button">换一批 ' + ic('refresh') + '</button></div><div class="grid" id="fy">' + gridSk(2) + '</div><div class="sentinel" id="sent"></div></section></div>');
    rowsReady(root);
    var hero = $('.hero', root), fy = $('#fy', root), shown = null, seenReco = {};
    function paintHero(items) {
      var picks = (items || []).slice(0, 5);
      if (!picks.length || !root.isConnected || !hero.isConnected) return;
      renderHero(hero, picks); heroCarousel(hero, picks); hasHero = true; onScroll();
    }
    function paint(items) {
      shown = items; remember(items);
      items.forEach(function (s) { if (s && s.id) seenReco[s.id] = 1; });
      fy.innerHTML = items.map(function (s, i) { return card(s, { i: i }); }).join('');
    }
    function updateContinue(list) {
      var el = $('#cont', root); if (!el || !root.isConnected) return;
      var total = (list || []).length;
      var slice = (list || []).slice(0, 12);
      if (!slice.length) { el.innerHTML = ''; return; }
      var heading = '继续观看 <small class="sh-cnt">' + total + ' 部</small>';
      var row = $('.row', el);
      if (!row) {
        el.innerHTML = shelf(heading, '/mine', '', slice.map(function (c, i) { return cwMini(c, i); }).join(''));
        rowsReady(root);
        return;
      }
      var cntEl = $('.sh-cnt', el);
      if (cntEl) cntEl.textContent = total + ' 部';
      var existing = new Map();
      $$(':scope > [data-cw]', row).forEach(function (node) { existing.set(node.dataset.cw, node); });
      var prevFirst = row.firstElementChild && row.firstElementChild.dataset ? row.firstElementChild.dataset.cw : '';
      var keep = new Set();
      var ordered = slice.map(function (c, i) {
        keep.add(c.seriesId);
        var pr = c.episodeCount ? Math.min(1, (c.episodeIndex + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
        var subText = '看到第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' / 共 ' + c.episodeCount + ' 集' : '');
        var node = existing.get(c.seriesId);
        if (node) {
          var bar = $('.cwpb i', node); if (bar) bar.style.width = (pr * 100) + '%';
          var t = $('.t', node); if (t && c.title && t.textContent !== c.title) t.textContent = c.title;
          var s = $('.s', node); if (s && s.textContent !== subText) s.textContent = subText;
          return node;
        }
        var tmp = document.createElement('div');
        tmp.innerHTML = cwMini(c, i);
        node = tmp.firstElementChild;
        if (node) node.classList.add('cw-new');
        return node;
      }).filter(Boolean);
      existing.forEach(function (node, id) { if (!keep.has(id)) node.remove(); });
      ordered.forEach(function (node, idx) {
        var cur = row.children[idx];
        if (cur !== node) row.insertBefore(node, cur || null);
      });
      if (prevFirst && ordered[0] && ordered[0].dataset.cw !== prevFirst && row.scrollLeft > 0) {
        row.scrollTo({ left: 0, behavior: 'smooth' });
      }
      arrState(row);
    }
    function historyChanged(e) { if (root.isConnected) updateContinue(e.detail && e.detail.seriesId ? mergeRecentHistory([e.detail].concat(hist)) : (e.detail || hist)); }
    window.addEventListener('lv:history', historyChanged); window.addEventListener('lv:progress', historyChanged);
    cleanups.push(function () { window.removeEventListener('lv:history', historyChanged); window.removeEventListener('lv:progress', historyChanged); });
    if (hist.length) updateContinue(hist);
    if (cached && cached.length) paint(cached);
    if (cachedHero && cachedHero.length) paintHero(cachedHero);
    else boardItems(HERO_BOARD, 5).then(function (list) {
      if (!root.isConnected || !isHomePath()) return;
      if (!list.length) { hero.remove(); return; }
      var picks = list.slice(0, 5).map(slim); persist('hero.' + HERO_BOARD, picks); paintHero(picks);
    }).catch(function () { if (!cachedHero && hero.isConnected) { hero.remove(); hasHero = false; onScroll(); } });
    // 预热首部最可能被点击的剧集（继续观看第 1 部或主视觉第 1 部），点击播放时详情与视频流已在缓存中
    var warmFirstTimer = setTimeout(function () {
      if (PL || OPENING || !root.isConnected || !isHomePath()) return;
      var top = hist[0];
      if (top && top.seriesId) {
        api('/api/detail', { query: { id: top.seriesId, lite: '1' }, ttl: TTL }).catch(function () {});
        if (top.vid) playInfo(top.vid, LV.get('quality')).catch(function () {});
      } else if (cachedHero && cachedHero[0] && cachedHero[0].id) {
        api('/api/detail', { query: { id: cachedHero[0].id, lite: '1' }, ttl: TTL }).catch(function () {});
        if (cachedHero[0].firstVid) playInfo(cachedHero[0].firstVid, LV.get('quality')).catch(function () {});
      }
    }, 180);
    cleanups.push(function () { clearTimeout(warmFirstTimer); });
    // 热播榜（一排）：先用本地缓存，与 /api/home 并行后台刷新，不阻塞在 /api/home 之后
    var hot = $('#hot', root), hrow = $('.row', hot), hk = 'b.' + HOME_BOARD, hhit = persist(hk), hdrawn = false;
    function hdraw(list) { hrow.innerHTML = list.map(function (s, i) { return card(s, { rank: i + 1, i: i }); }).join(''); arrState(hrow); hdrawn = true; }
    if (hhit && hhit.length >= 6) { remember(hhit); hdraw(hhit); }
    boardItems(HOME_BOARD, 12).then(function (list) {
      if (!root.isConnected || !isHomePath()) return;
      if (list.length >= 6) persist(hk, list.map(slim));
      if (!hdrawn) { if (list.length < 6) hot.remove(); else hdraw(list); }
    }).catch(function () { if (!hdrawn && hot.isConnected) hot.remove(); });
    var data; try { data = await api('/api/home', { ttl: 0 }); } catch (e) {
      if (!shown && !cachedHero) { hero.remove(); hasHero = false; $('.shelves', root).innerHTML = '<div style="padding-top:var(--nav)">' + failed(e.message) + '</div>'; onScroll(); return; }
      data = { forYou: { items: shown, next: -1, more: false }, continue: [], channels: [], cell: '', session: '' };
    }
    if (!isHomePath() || !root.isConnected) return;
    var items = data.forYou.items || []; remember(items);
    // 若本地缓存已画出多行，把最新推荐合并到最前面并保持整行数量，避免刷新首页时从两三行突然缩水成 6 张
    var homeList = items;
    if (shown && shown.length > items.length) {
      var seenMerge = {};
      homeList = [];
      items.concat(shown).forEach(function (s) {
        if (s && s.id && !seenMerge[s.id]) { seenMerge[s.id] = 1; homeList.push(s); }
      });
      var c0 = cols();
      if (homeList.length >= c0) homeList = homeList.slice(0, Math.floor(homeList.length / c0) * c0);
    }
    if (homeList.length) persist('home', homeList.slice(0, Math.max(24, cols() * 3)).map(slim));
    // 首页「为你推荐」可随会话更新；主视觉独立使用推荐榜持久缓存。
    if (homeList.length && (!shown || shown.map(function (x) { return x.id; }).join() !== homeList.map(function (x) { return x.id; }).join())) paint(homeList);
    remember((data.continue || []).map(function (c) { return { id: c.seriesId, title: c.title, cover: c.cover, episodes: c.episodeCount }; }));
    hist = historyLoaded ? mergeRecentHistory((data.continue || []).concat(hist)) : mergeRecentHistory(data.continue || []);
    saveCachedHist(); updateContinue(hist);
    // 为你推荐：接口每页只有 6 部、约 1 秒 → 后台预取攒到缓冲区，每次按整行追加（至少两行），不再一张张往外冒
    function cols() { var t = getComputedStyle(fy).gridTemplateColumns; return t && t !== 'none' ? t.split(' ').length : 6; }
    var inf = null, feedGen = 0, sent = $('#sent', root);
    // 一个频道的推荐流：first 为已经画出来的第一页（可选 buf 放多余尾项，保证首屏凑整行）
    function startFeed(ch, first) {
      var gen = ++feedGen, seenId = {}, next = first.next, cell = first.cell, sess = first.session, buf = (first.buf || []).slice(), more = true, pending = null;
      first.items.forEach(function (s) { seenId[s.id] = 1; seenReco[s.id] = 1; });
      buf.forEach(function (s) { seenId[s.id] = 1; seenReco[s.id] = 1; });
      // 推荐频道翻几页后只会回已出现过的剧：连续 2 页没有新剧就改从各榜单接着取（去重）；漫剧等频道不混入榜单
      var dry = 0, src = first.more ? 'fy' : 'board', bq = null, bi = 0, boff = 0, bsess = '';
      if (src === 'board' && ch !== '16') more = false;
      function fetchPage() {
        if (pending || !more) return pending || Promise.resolve();
        var before = buf.length, req;
        if (src === 'fy') req = api('/api/foryou', { query: { channel: ch, offset: next, cell: cell, session: sess } }).then(function (r) {
          remember(r.page.items);
          r.page.items.forEach(function (s) { if (!seenId[s.id] && !seenReco[s.id]) { seenId[s.id] = 1; seenReco[s.id] = 1; buf.push(s); } });
          next = r.page.next; cell = r.cell; sess = r.session;
          if (!(r.page.more && r.page.items.length)) dry = 9;
        });
        else req = (bq ? Promise.resolve(bq) : boards().then(function (bl) { bq = bl.map(function (b) { return b.id; }); return bq; })).then(function (ids) {
          if (bi >= ids.length) { more = false; return; }
          return api('/api/rank', { query: { board: ids[bi], offset: boff, session: bsess } }).then(function (r) {
            remember(r.items);
            r.items.forEach(function (s) { if (!seenId[s.id] && !seenReco[s.id]) { seenId[s.id] = 1; seenReco[s.id] = 1; buf.push(s); } });
            if (r.more && r.items.length) { boff = r.next; bsess = r.session; } else { bi++; boff = 0; bsess = ''; }
          });
        });
        pending = req.then(function () {
          dry = buf.length > before ? 0 : dry + 1;
          if (src === 'fy' && dry >= 2) { if (ch === '16') { src = 'board'; dry = 0; } else more = false; }
          else if (src === 'board' && dry >= 3) { bi++; boff = 0; bsess = ''; dry = 0; }
        }).catch(function () { if (src === 'fy' && ch === '16') { src = 'board'; dry = 0; } else more = false; }).then(function () { pending = null; });
        return pending;
      }
      function live() { return gen === feedGen && root.isConnected; }
      function prefetch() { var c = cols(); (function go() { if (PL || OPENING) return; if (buf.length < c * 3 && more && live()) fetchPage().then(go); })(); }
      if (inf) inf.stop();
      sent.hidden = false;
      inf = LV.infinite(sent, async function () {
        var c = cols(), have = fy.querySelectorAll(':scope > .card:not(.sk)').length;
        // 只要补齐当前残缺行（若已是整行则补 1 整行）就立刻渲染并撤掉骨架屏，避免宽屏下为凑两整行连等两轮请求
        var need = (c - have % c) % c || c;
        while (buf.length < need && more && live()) await fetchPage();
        if (!live()) return false;
        have = fy.querySelectorAll(':scope > .card:not(.sk)').length;
        var take = more ? Math.max(0, Math.floor((have + buf.length) / c) * c - have) : buf.length;
        var added = buf.splice(0, take);
        if (added.length) {
          var h = added.map(function (s, k) { return card(s, { i: k }); }).join('');
          var sk = fy.querySelector(':scope > .sk-tail');
          if (sk) sk.insertAdjacentHTML('beforebegin', h); else fy.insertAdjacentHTML('beforeend', h);
          if (ch === '16') {
            shown = (shown || []).concat(added);
            if (shown.length <= Math.max(24, c * 3)) persist('home', shown.map(slim));
            if (chCache['16']) chCache['16'] = { page: { items: shown.slice(), next: next, more: more }, cell: cell, session: sess };
          }
        }
        prefetch();
        return more || buf.length > 0;
      }, { host: fy, skel: cardSk });
      prefetch(); // 首屏一画完就开始预取
    }
    var initialForYou = (shown && shown.length ? shown : items).slice();
    var chCache = { '16': { page: { items: initialForYou, next: data.forYou.next, more: data.forYou.more }, cell: data.cell, session: data.session } };
    startFeed('16', { items: initialForYou, next: data.forYou.next, more: data.forYou.more, cell: data.cell, session: data.session });
    // 频道切换（推荐 / 漫剧等）：预热次要频道首屏 + 本地缓存 + 凑整行展示，切频道即时出图不闪两次加载
    var chs = data.channels || [], chBox = $('#fych', root), curCh = '16';
    var chPending = {};
    function fetchChannelFirst(chId) {
      if (chCache[chId]) return Promise.resolve(chCache[chId]);
      if (chPending[chId]) return chPending[chId];
      chPending[chId] = api('/api/foryou', { query: { channel: chId, offset: 0 } }).then(function (r) {
        if (r && r.page && r.page.items && r.page.items.length) chCache[chId] = r;
        delete chPending[chId];
        return r;
      }, function (er) { delete chPending[chId]; throw er; });
      return chPending[chId];
    }
    function applyChannelResult(chId, r) {
      var raw = (r && r.page && r.page.items) || [];
      remember(raw);
      var c = cols(), moreFlag = !!(r && r.page && r.page.more);
      var drawN = (moreFlag && raw.length >= c) ? Math.floor(raw.length / c) * c : raw.length;
      var vis = raw.slice(0, drawN), rest = raw.slice(drawN);
      fy.innerHTML = vis.map(function (s, i) { return card(s, { i: i }); }).join('') || '<div class="mempty">暂无内容</div>';
      feedGen--;   // startFeed 自己会 +1，保持与当前切换同一代
      startFeed(chId, { items: vis, buf: rest, next: r.page.next, more: r.page.more, cell: r.cell, session: r.session });
    }
    if (chs.length > 1) {
      chBox.innerHTML = chs.map(function (c) { return '<button class="chip' + (c.id === curCh ? ' on' : '') + '" data-ch="' + esc(c.id) + '">' + esc(c.label) + '</button>'; }).join('');
      var warmTimer = setTimeout(function () {
        if (!root.isConnected || !isHomePath() || PL || OPENING) return;
        chs.forEach(function (c) { if (c.id !== '16') fetchChannelFirst(c.id).catch(function () {}); });
      }, 300);
      cleanups.push(function () { clearTimeout(warmTimer); });
      chBox.addEventListener('click', function (e) {
        var b = e.target.closest('[data-ch]'); if (!b) return;
        if (b.dataset.ch === curCh) { swapBatch(); return; }
        curCh = b.dataset.ch; $$('.chip', chBox).forEach(function (x) { x.classList.toggle('on', x === b); });
        var gen = ++feedGen; if (inf) inf.stop();
        if (chCache[curCh]) { applyChannelResult(curCh, chCache[curCh]); return; }
        fy.innerHTML = gridSk(2);
        fetchChannelFirst(curCh).then(function (r) {
          if (gen !== feedGen || !root.isConnected) return;
          applyChannelResult(curCh, r);
        }, function (er) { if (gen === feedGen) { fy.innerHTML = '<div class="mempty">' + esc(er.message) + '</div>'; } });
      });
    }
    var swapButton = $('#fy-swap', root), swapping = false;
    async function swapBatch() {
      if (swapping || !root.isConnected) return;
      var targetCh = curCh, startGen = feedGen;
      swapping = true; swapButton.disabled = true; swapButton.classList.add('busy');
      try {
        // Start a new upstream feed session and keep paging until it yields a fresh batch.
        var first = await api('/api/foryou', { query: { channel: targetCh, offset: 0 } });
        if (!root.isConnected || curCh !== targetCh || feedGen !== startGen) return;
        var rows = [], local = {}, page = first.page, cell = first.cell, session = first.session;
        function addFresh(items) {
          (items || []).forEach(function (s) {
            if (s && s.id && !seenReco[s.id] && !local[s.id]) { local[s.id] = 1; rows.push(s); }
          });
        }
        addFresh(page.items);
        var tries = 0;
        while (rows.length < Math.max(12, cols() * 2) && page.more && tries++ < 8) {
          var nextPage = await api('/api/foryou', { query: { channel: targetCh, offset: page.next, cell: cell, session: session } });
          if (!root.isConnected || curCh !== targetCh || feedGen !== startGen) return;
          page = nextPage.page; cell = nextPage.cell; session = nextPage.session;
          addFresh(page.items);
        }
        if (!root.isConnected || curCh !== targetCh || feedGen !== startGen) return;
        if (!rows.length) { LV.toast('暂时没有更多新推荐'); return; }
        // Invalidate an in-flight old infinite-scroll request before replacing its grid.
        feedGen++; if (inf) inf.stop();
        remember(rows); rows.forEach(function (s) { seenReco[s.id] = 1; });
        fy.innerHTML = rows.map(function (s, i) { return card(s, { i: i }); }).join('');
        if (targetCh === '16') {
          shown = rows.slice();
          persist('home', rows.slice(0, Math.max(24, cols() * 3)).map(slim));
        }
        chCache[targetCh] = { page: { items: rows.slice(), next: page.next, more: page.more }, cell: cell, session: session };
        startFeed(targetCh, { items: rows, next: page.next, more: page.more, cell: cell, session: session });
      } catch (e) { LV.toast(e.message || '换一批失败'); }
      finally { swapping = false; swapButton.disabled = false; swapButton.classList.remove('busy'); }
    }
    swapButton.addEventListener('click', swapBatch);
    cleanups.push(function () { feedGen++; if (inf) inf.stop(); }); rowsReady(root); ready(); onScroll();
  }

  // ------------------------------------------------------------ 榜单
  async function rank() {
    title('榜单');
    var root = mount('<div class="page-top"><h1 class="lt">榜单</h1><div class="filters rb-filters" id="rty"></div></div>' +
      '<div class="bar2 ranktabs"><div class="seg sk">' + '<div class="skel" style="width:64px;height:22px;border-radius:8px;flex:none;margin:9px 14px"></div>'.repeat(8) + '</div></div><div id="rc"><div class="grid">' + gridSk(3) + '</div></div>');
    var bl, types = [], type = 'all';
    try { var o0 = await api('/api/category/options', { query: { type: 'all' }, ttl: 600000 }); if (!root.isConnected) return; bl = o0.boards; types = o0.types || []; } catch (e) { if (root.isConnected) $('#rc', root).innerHTML = failed(e.message); return; }
    var cur = new URLSearchParams(location.search).get('board') || bl[0].id, inf = null;
    if (!bl.some(function (b) { return b.id === cur; })) cur = bl[0].id;
    function drawBoards() { $('.bar2', root).innerHTML = seg(bl.map(function (b) { return [b.id, b.label]; }), cur, 'data-b'); placeSeg(root); }
    drawBoards();
    // 类型（全部 / 漫剧 / 真人剧 / AI剧）：与分类页同一套 .frow 样式；切换后榜单标签与内容一起联动
    function drawTypes() {
      $('#rty', root).innerHTML = types.length > 1 ? '<div class="frow"><div class="fchips">' +
        types.map(function (t) { return '<button class="chip' + (type === t.id ? ' on' : '') + '" data-t="' + esc(t.id) + '">' + esc(t.label) + '</button>'; }).join('') + '</div></div>' : '';
    }
    drawTypes();
    $('#rty', root).addEventListener('click', async function (e) {
      var b = e.target.closest('[data-t]'); if (!b || b.dataset.t === type) return;
      var want = b.dataset.t; type = want; drawTypes();
      try { var o = await api('/api/category/options', { query: { type: want }, ttl: 600000 }); if (type !== want || !root.isConnected) return; var ob = (o.boards || []).filter(function (x) { return want === 'all' || !/_hot_(sc|rank)$/.test(x.id); }); if (ob.length) bl = ob; } catch (er) { if (type !== want || !root.isConnected) return; LV.toast(er.message); }
      if (type !== want || !root.isConnected) return;
      if (!bl.some(function (x) { return x.id === cur; })) cur = bl[0].id;
      drawBoards(); load(cur);
    });
    function load(id) {
      cur = id; if (inf) inf.stop();
      $$('.bar2 button', root).forEach(function (b) { b.classList.toggle('on', b.dataset.b === id); }); placeSeg(root);
      title((bl.find(function (b) { return b.id === id; }) || {}).label || '榜单');
      var rc = $('#rc', root); rc.innerHTML = '<div class="grid" id="rg">' + gridSk(3) + '</div><div class="sentinel" id="sent"></div>';
      var g = $('#rg', rc), off = 0, sess = '', seen = {}, no = 0, first = true;
      inf = LV.infinite($('#sent', rc), async function () {
        var ty = type;
        var r = ty === 'all' ? await api('/api/rank', { query: { board: id, offset: off, session: sess }, ttl: off ? 0 : TTL })
          : await api('/api/category', { query: { type: ty, board: id, offset: off, session: sess }, ttl: off ? 0 : TTL });
        if (cur !== id || type !== ty) return false;
        remember(r.items);
        var h = '', k = 0;
        r.items.forEach(function (s) { if (s && s.id && !seen[s.id]) { seen[s.id] = 1; no++; h += card(s, { rank: no, i: k++ }); } });
        if (first) {
          first = false; g.innerHTML = '';
          if (!h) { rc.innerHTML = empty('chart', '这个榜单暂时没有内容'); return false; }
          ready();
        }
        if (h) g.insertAdjacentHTML('beforeend', h);
        off = r.next; sess = r.session; return !!(r.more && r.items.length);
      }, { host: g, skel: cardSk });
      cleanups.push(inf.stop);
    }
    $('.bar2', root).addEventListener('click', function (e) {
      var b = e.target.closest('[data-b]'); if (!b || b.dataset.b === cur) return;
      quietURL('/rank?board=' + b.dataset.b);
      var top = $('.bar2', root).offsetTop - nav.offsetHeight - 12; if (window.scrollY > top) window.scrollTo({ top: top, behavior: 'smooth' });
      load(b.dataset.b);
    });
    load(cur);
  }

  // ------------------------------------------------------------ 分类
  async function category() {
    title('分类');
    var st = { type: 'all', board: '', sel: {} };
    var root = mount('<div class="page-top"><h1 class="lt">分类</h1><button type="button" class="btn sm ghost" id="cat-reset" hidden>' + ic('refresh') + '<span>重置筛选</span></button></div>' +
      '<div class="filters cat-filters" id="fl">' + [180, 520, 760, 760].map(function (w) { return '<div class="frow"><div class="skel t" style="width:36px;flex:none;margin-right:28px"></div><div class="skel" style="width:' + w + 'px;height:36px;border-radius:99px"></div></div>'; }).join('') + '</div>' +
      '<div class="grid" id="g" style="margin-top:24px">' + gridSk(3) + '</div><div class="sentinel" id="sent"></div>');
    var inf, opts;
    async function loadOpts() {
      var keep = {}; $$('.fchips', root).forEach(function (f, i) { keep[i] = f.scrollLeft; });
      opts = await api('/api/category/options', { query: { type: st.type }, ttl: 600000 });
      if (!st.board || !opts.boards.some(function (b) { return b.id === st.board; })) st.board = opts.boards[0] ? opts.boards[0].id : '';
      var cur = opts.boards.find(function (b) { return b.id === st.board; });
      var NAME = { '综合': '受众', '时代背景': '背景', '主题情节': '题材', '角色设定': '人设' };
      var html = '';
      // 分类页不放类型（漫剧 / 真人剧 / AI剧）：类型只在榜单页区分
      html += (cur ? cur.groups.map(function (g) {
          return '<div class="frow"><h4>' + esc(NAME[g.name] || g.name) + '</h4><div class="fchips"><button class="chip' + (!st.sel[g.name] ? ' on' : '') + '" data-g="' + esc(g.name) + '" data-o="">全部</button>' +
            g.items.map(function (o) { return '<button class="chip' + (st.sel[g.name] === o.id ? ' on' : '') + '" data-g="' + esc(g.name) + '" data-o="' + o.id + '">' + esc(o.label) + '</button>'; }).join('') + '</div></div>';
        }).join('') : '');
      $('#fl', root).innerHTML = html;
      var hasSel = Object.keys(st.sel).some(function (k) { return !!st.sel[k]; });
      var resetBtn = $('#cat-reset', root);
      if (resetBtn) resetBtn.hidden = !hasSel;
      $$('.fchips', root).forEach(function (f, i) { if (keep[i]) f.scrollLeft = keep[i]; });
      placeSeg(root);
    }
    function loadGrid() {
      if (inf) inf.stop(); var g = $('#g', root);
      if (!g.classList.contains('grid')) { g.outerHTML = '<div class="grid" id="g" style="margin-top:26px"></div>'; g = $('#g', root); }
      g.innerHTML = gridSk(2); $('#sent', root).hidden = false;
      var off = 0, sess = '', seen = {}, first = true, tok = JSON.stringify(st);
      var sel = Object.keys(st.sel).filter(function (k) { return st.sel[k]; }).map(function (k) { return k + ':' + st.sel[k]; });
      inf = LV.infinite($('#sent', root), async function () {
        var r = await api('/api/category', { query: { type: st.type, board: st.board, offset: off, session: sess, sel: sel } }); if (tok !== JSON.stringify(st)) return false;
        remember(r.items); var h = '', k = 0; r.items.forEach(function (s) { if (!seen[s.id]) { seen[s.id] = 1; h += card(s, { i: k++ }); } });
        if (first) { g.innerHTML = ''; first = false; ready(); }
        if (h) g.insertAdjacentHTML('beforeend', h);
        if (!r.more && !Object.keys(seen).length) { g.outerHTML = '<div id="g">' + empty('grid', '没有符合条件的剧', '换个条件试试') + '</div>'; return false; }
        off = r.next; sess = r.session; return !!r.more;
      }, { host: g, skel: cardSk });
      cleanups.push(inf.stop);
    }
    var applyGen = 0;
    async function apply() { var gen = ++applyGen; try { await loadOpts(); if (gen !== applyGen || !root.isConnected) return; loadGrid(); } catch (er) { if (gen === applyGen && root.isConnected) LV.toast(er.message); } }
    root.addEventListener('click', function (e) {
      if (e.target.closest('#cat-reset')) { st.sel = {}; apply(); return; }
      var t = e.target.closest('[data-t]'), b = e.target.closest('[data-bd]'), c = e.target.closest('[data-g]');
      if (t && t.dataset.t !== st.type) { st.type = t.dataset.t; st.board = ''; st.sel = {}; apply(); }
      else if (b && b.dataset.bd !== st.board) { st.board = b.dataset.bd; st.sel = {}; apply(); }
      else if (c && (st.sel[c.dataset.g] || '') !== c.dataset.o) { st.sel[c.dataset.g] = c.dataset.o; apply(); }
    });
    try { await loadOpts(); loadGrid(); } catch (e) { $('#g', root).outerHTML = '<div id="g">' + failed(e.message) + '</div>'; }
  }

  // ------------------------------------------------------------ 搜索：关键词联想 + 热门搜索词 + 独立搜索结果页
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem('lvguo.recent') || '[]'); } catch (e) {}
  function saveRecent(t) { t = (t || '').trim(); if (!t) return; recent = [t].concat(recent.filter(function (x) { return x !== t; })).slice(0, 12); try { localStorage.setItem('lvguo.recent', JSON.stringify(recent)); } catch (e) {} }
  function toKeyword(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/[：:·\-—\u2014，,！!？?].*$/, '').replace(/[（(\[【《》\]】）].*$/, '').trim();
    if (!s) s = String(raw || '').trim();
    return s.length > 10 ? s.slice(0, 10) : s;
  }
  function extractHotKeywords(list) {
    var out = [], seen = Object.create(null);
    (list || []).forEach(function (item) {
      if (!item) return;
      var kws = [];
      if (item.title) kws.push(toKeyword(item.title));
      (item.category || '').split(',').forEach(function (c) { c = c.trim(); if (c && c.length <= 8) kws.push(c); });
      kws.forEach(function (kw) {
        if (!kw || kw.length < 2 || seen[kw]) return;
        seen[kw] = 1;
        out.push(kw);
      });
    });
    return out.slice(0, 16);
  }
  var HOT = null, HOT_KW = null, HOT_T = 0, hotLoading = null, searchLiveRun = null, closeTopSuggest = function () {};
  var DEFAULT_HOT_KW = ['都市', '甜宠', '古装', '战神', '逆袭', '重生', '悬疑', '家庭', '闪婚', '总裁'];
  (function () {
    var h = persist('hot'); if (h && h.v) { HOT = h.v; HOT_T = h.t; remember(HOT); }
    var hk = persist('hotkw'); if (hk && Array.isArray(hk.v) && hk.v.length) HOT_KW = hk.v;
    else if (HOT) HOT_KW = extractHotKeywords(HOT);
  })();
  function localSeedKeywords() {
    var out = [], seen = Object.create(null);
    function pushKw(kw) { if (kw && kw.length >= 2 && !seen[kw] && out.length < 12) { seen[kw] = 1; out.push(kw); } }
    Object.keys(cache).slice(0, 24).forEach(function (id) {
      var item = cache[id];
      if (!item) return;
      if (item.title) pushKw(toKeyword(item.title));
      (item.category || '').split(',').forEach(function (c) { pushKw(c.trim()); });
    });
    DEFAULT_HOT_KW.forEach(pushKw);
    return out;
  }
  function loadHotKeywords() {
    if (HOT_KW && HOT_KW.length && Date.now() - HOT_T < 600000) return Promise.resolve(HOT_KW);
    if (hotLoading) return hotLoading;
    hotLoading = boards().then(function (bl) {
      return boardItems((bl.find(function (b) { return /热搜/.test(b.label); }) || bl[0]).id, 24);
    }).then(function (list) {
      if (list && list.length) {
        HOT = list.map(slim); HOT_T = Date.now(); HOT_KW = extractHotKeywords(list);
        persist('hot', { t: HOT_T, v: HOT }); persist('hotkw', { t: HOT_T, v: HOT_KW });
      }
      return HOT_KW || localSeedKeywords();
    }).catch(function () { return HOT_KW || localSeedKeywords(); }).then(function (res) { hotLoading = null; return res; });
    return hotLoading;
  }
  function closeSearch() { closeTopSuggest(); }
  function syncTopSearch(q) {
    var topIn = $('#topSearchInput'), topClr = $('#topSearchClear');
    if (topIn && topIn.value !== (q || '')) topIn.value = q || '';
    if (topClr) topClr.hidden = !(q && q.trim());
  }
  function openSearch(q0) {
    if (PL) return;
    closeTopSuggest();
    var q = (q0 || '').trim();
    if (q) saveRecent(q);
    if (stripBase(location.pathname) === '/search' && searchLiveRun) {
      var spIn = $('#sp-input');
      if (q) { if (spIn) spIn.value = q; syncTopSearch(q); searchLiveRun(q, true); }
      else if (spIn) { spIn.focus(); spIn.select(); }
      return;
    }
    go('/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
  }
  function searchPage(q0) {
    title(q0 ? ('搜索 · ' + q0) : '搜索');
    syncTopSearch(q0 || '');
    var root = mount('<div class="spage">' +
      '<div class="sp-head"><h1>搜索</h1>' +
      '<form id="sp-form" class="sp-box" autocomplete="off">' + ic('search') +
      '<input id="sp-input" type="search" placeholder="输入剧名、演员或关键词..." spellcheck="false" value="' + esc(q0 || '') + '">' +
      '<button id="sp-clear" class="sp-clr" type="button"' + (q0 ? '' : ' hidden') + ' aria-label="清除">' + ic('close') + '</button>' +
      '<button class="btn primary sp-go" type="submit">搜索</button></form></div>' +
      '<div id="sp-body"></div></div>');
    var form = $('#sp-form', root), inp = $('#sp-input', root), clr = $('#sp-clear', root), body = $('#sp-body', root);
    var tok = 0, page = 1, lastQ = null, seen = {}, totalShown = 0, inf = null;
    setTimeout(function () { if (root.isConnected && !q0) inp.focus(); }, 30);

    function stopInf() { if (inf) { inf.stop(); inf = null; } }
    function renderHotKeywords(kws) {
      if (!kws || !kws.length) return '';
      return kws.map(function (kw, i) {
        return '<button type="button" class="hot-kw" data-q="' + esc(kw) + '">' +
          '<span class="hk-n' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>' +
          '<span class="hk-t">' + esc(kw) + '</span></button>';
      }).join('');
    }
    function idle() {
      stopInf();
      var recHtml = recent.length ? '<section class="sp-sec"><div class="sp-sh"><h2>最近搜索</h2><button type="button" class="more" data-clear>清空</button></div><div class="sp-chips">' + recent.slice(0, 12).map(function (t) { return '<button type="button" class="chip" data-q="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div></section>' : '';
      body.innerHTML = recHtml + '<section class="sp-sec"><div class="sp-sh"><h2>大家都在搜</h2></div><div class="hot-kws" id="sp-hot">' +
        (HOT_KW && HOT_KW.length ? renderHotKeywords(HOT_KW) : '<div class="skel" style="height:44px;border-radius:10px"></div><div class="skel" style="height:44px;border-radius:10px"></div><div class="skel" style="height:44px;border-radius:10px"></div><div class="skel" style="height:44px;border-radius:10px"></div>') +
        '</div></section>';
      loadHotKeywords().then(function (kws) {
        if (!root.isConnected || inp.value.trim()) return;
        var el = $('#sp-hot', body);
        if (el) el.innerHTML = kws.length ? renderHotKeywords(kws) : '<p style="color:var(--text-3);font-size:13.5px">暂无热门关键词</p>';
      });
    }

    async function loadPage(q, curTok) {
      var curPage = page;
      try {
        var r = await api('/api/search', { query: { q: q, page: curPage }, ttl: TTL });
        if (!root.isConnected || curTok !== tok) return false;
        remember(r.items);
        var grid = $('#sp-grid', body); if (!grid) return false;
        var list = (r.items || []).filter(function (s) { if (!s || !s.id || seen[s.id]) return false; seen[s.id] = 1; return true; });
        if (curPage === 1) {
          if (!list.length) {
            stopInf();
            body.innerHTML = '<div class="sp-none">' + empty('search', '没有找到“' + q + '”相关的剧', '换个关键词试试', '<button type="button" class="btn" data-reset>返回热搜词</button>') + '</div>';
            return false;
          }
          grid.innerHTML = '';
        }
        totalShown += list.length;
        var cntEl = $('#sp-cnt', body);
        if (cntEl) cntEl.textContent = '已显示 ' + totalShown + (r.more ? '+' : '') + ' 部';
        grid.insertAdjacentHTML('beforeend', list.map(function (s, i) {
          var sub = [s.episodes ? s.episodes + ' 集' : '', LV.plays(s.plays)].concat(cats(s, 1)).filter(Boolean).join(' · ');
          return card(s, { i: i, th: hl(s.title, q), sub: sub });
        }).join(''));
        page = curPage + 1;
        return !!(r.more && list.length);
      } catch (e) {
        if (!root.isConnected || curTok !== tok) return false;
        if (curPage === 1) { stopInf(); body.innerHTML = failed(e.message); }
        else LV.toast(e.message || '加载失败，请重试');
        return false;
      }
    }

    function run(q, commit) {
      q = (q || '').trim();
      clr.hidden = !q;
      syncTopSearch(q);
      if (commit && q) saveRecent(q);
      if (q === lastQ && !commit) return;
      if (q === lastQ && commit) return;
      lastQ = q;
      quietURL('/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
      title(q ? ('搜索 · ' + q) : '搜索');
      var curTok = ++tok;
      stopInf();
      if (!q) return idle();
      totalShown = 0;
      body.innerHTML = '<section class="sp-sec"><div class="sp-sh"><h2>“' + esc(q) + '”的搜索结果</h2><span class="sp-cnt" id="sp-cnt"></span></div><div class="grid" id="sp-grid">' + gridSk(2) + '</div><div class="sentinel" id="sp-sent"></div></section>';
      page = 1; seen = {};
      loadPage(q, curTok).then(function (hasMore) {
        if (!hasMore || !root.isConnected || curTok !== tok) return;
        var grid = $('#sp-grid', body), sent = $('#sp-sent', body);
        if (!grid || !sent) return;
        inf = LV.infinite(sent, function () {
          if (!root.isConnected || curTok !== tok) return Promise.resolve(false);
          return loadPage(q, curTok);
        }, { host: grid, skel: cardSk });
        cleanups.push(stopInf);
      });
    }

    searchLiveRun = run;
    cleanups.push(function () { stopInf(); if (searchLiveRun === run) searchLiveRun = null; syncTopSearch(''); });

    inp.addEventListener('input', function () {
      var v = inp.value.trim();
      clr.hidden = !v;
      if (!v && lastQ) run('', false);
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); run(inp.value, true); });
    clr.onclick = function () { inp.value = ''; run('', false); inp.focus(); };
    root.addEventListener('click', function (e) {
      var qbtn = e.target.closest('[data-q]'), cl = e.target.closest('[data-clear]'), rs = e.target.closest('[data-reset]'), cid = e.target.closest('[data-id]');
      if (cid && inp.value.trim()) saveRecent(inp.value.trim());
      if (qbtn) { inp.value = qbtn.dataset.q; run(qbtn.dataset.q, true); }
      else if (cl) { recent = []; try { localStorage.removeItem('lvguo.recent'); } catch (x) {} lastQ = null; run('', false); }
      else if (rs) { inp.value = ''; run('', false); inp.focus(); }
    });
    run(inp.value, !!inp.value);
  }
  (function () {
    var tf = $('#topSearchForm'), ti = $('#topSearchInput'), tc = $('#topSearchClear'), td = $('#topSuggest');
    if (!tf || !ti || !td) return;
    var reqTok = 0, activeIdx = -1;
    function hideSuggest() { td.hidden = true; td.innerHTML = ''; activeIdx = -1; }
    closeTopSuggest = hideSuggest;
    function renderSuggest(q, items, loadingMore) {
      if (!items.length && !loadingMore) { hideSuggest(); return; }
      activeIdx = -1;
      var hd = q ? '搜索建议' : (recent.length ? '最近 / 热门搜索' : '大家都在搜');
      var rowsHtml = items.map(function (it) {
        return '<button type="button" class="ts-item" data-sq="' + esc(it.kw) + '">' + ic(it.isRecent ? 'clock' : 'search') +
          '<span class="ts-txt">' + (q ? hl(it.kw, q) : esc(it.kw)) + '</span>' +
          (it.tag ? '<span class="ts-tag">' + esc(it.tag) + '</span>' : '') + '</button>';
      }).join('');
      var skHtml = loadingMore ? [62, 48, 70, 54].map(function (w) {
        return '<div class="ts-sk"><i class="skel"></i><span class="skel" style="max-width:' + w + '%"></span></div>';
      }).join('') : '';
      td.innerHTML = '<div class="ts-hd">' + hd + '</div>' + rowsHtml + skHtml;
      td.hidden = false;
    }
    function fetchTopSuggest() {
      var q = ti.value.trim();
      var myTok = ++reqTok;
      if (!q) {
        var rItems = recent.slice(0, 5).map(function (kw) { return { kw: kw, isRecent: true, tag: '最近' }; });
        if (HOT_KW && HOT_KW.length) {
          var seen = Object.create(null); rItems.forEach(function (x) { seen[x.kw] = 1; });
          HOT_KW.forEach(function (kw) { if (!seen[kw] && rItems.length < 10) { seen[kw] = 1; rItems.push({ kw: kw, isRecent: false, tag: '热搜' }); } });
          renderSuggest('', rItems, false);
        } else {
          renderSuggest('', rItems, true);
          loadHotKeywords().then(function (kws) {
            if (myTok !== reqTok || document.activeElement !== ti || ti.value.trim()) return;
            var merged = recent.slice(0, 5).map(function (kw) { return { kw: kw, isRecent: true, tag: '最近' }; });
            var seen2 = Object.create(null); merged.forEach(function (x) { seen2[x.kw] = 1; });
            (kws || []).forEach(function (kw) { if (!seen2[kw] && merged.length < 10) { seen2[kw] = 1; merged.push({ kw: kw, isRecent: false, tag: '热搜' }); } });
            renderSuggest('', merged, false);
          });
        }
        return;
      }
      var lower = q.toLowerCase(), localSeen = Object.create(null), localMatches = [];
      recent.forEach(function (kw) {
        if (localMatches.length < 3 && kw.toLowerCase().indexOf(lower) >= 0 && !localSeen[kw]) {
          localSeen[kw] = 1; localMatches.push({ kw: kw, isRecent: true, tag: '历史' });
        }
      });
      ((HOT_KW && HOT_KW.length) ? HOT_KW : localSeedKeywords()).forEach(function (kw) {
        if (localMatches.length < 6 && kw.toLowerCase().indexOf(lower) >= 0 && !localSeen[kw]) {
          localSeen[kw] = 1; localMatches.push({ kw: kw, isRecent: false, tag: '热门' });
        }
      });
      if (localMatches.length) {
        renderSuggest(q, localMatches, false);
      } else {
        renderSuggest(q, [{ kw: q, isRecent: false, tag: '直达搜索' }], true);
      }
      api('/api/suggest', { query: { q: q }, ttl: 120000 }).then(function (r) {
        if (myTok !== reqTok || ti.value.trim() !== q) return;
        var seen = Object.create(null), list = localMatches.slice();
        list.forEach(function (x) { seen[x.kw] = 1; });
        (r.items || []).forEach(function (kw) {
          kw = String(kw || '').trim();
          if (kw && !seen[kw] && list.length < 10) { seen[kw] = 1; list.push({ kw: kw, isRecent: false, tag: '' }); }
        });
        if (!list.length) list.push({ kw: q, isRecent: false, tag: '搜索' });
        renderSuggest(q, list, false);
      }).catch(function () {
        if (myTok !== reqTok || ti.value.trim() !== q) return;
        if (!localMatches.length) renderSuggest(q, [{ kw: q, isRecent: false, tag: '搜索' }], false);
      });
    }
    var liveSuggest = LV.debounce(fetchTopSuggest, 60);
    ti.addEventListener('focus', function () { fetchTopSuggest(); });
    ti.addEventListener('click', function () { if (td.hidden) fetchTopSuggest(); });
    ti.addEventListener('input', function (e) {
      if (tc) tc.hidden = !ti.value.trim();
      if (!e.isComposing) liveSuggest();
    });
    ti.addEventListener('compositionend', function () { liveSuggest(); });
    ti.addEventListener('keydown', function (e) {
      if (td.hidden) return;
      var items = $$('.ts-item', td);
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = e.key === 'ArrowDown' ? (activeIdx + 1) % items.length : (activeIdx <= 0 ? items.length - 1 : activeIdx - 1);
        items.forEach(function (el, idx) { el.classList.toggle('on', idx === activeIdx); });
        ti.value = items[activeIdx].dataset.sq || ti.value;
        if (tc) tc.hidden = !ti.value.trim();
      } else if (e.key === 'Escape') {
        hideSuggest();
      }
    });
    td.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    td.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sq]');
      if (!b) return;
      var q = b.dataset.sq;
      ti.value = q;
      if (tc) tc.hidden = !q;
      hideSuggest();
      openSearch(q);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.top-search-wrap')) hideSuggest();
    });
    tf.addEventListener('submit', function (e) {
      e.preventDefault();
      hideSuggest();
      var q = ti.value.trim();
      openSearch(q);
    });
    if (tc) tc.onclick = function () {
      ti.value = ''; tc.hidden = true; ti.focus();
      fetchTopSuggest();
    };
  })();

  // ------------------------------------------------------------ 详情：海报 + 信息 + 选集（简介只出现一次）
  function epGroups(n) { return n > 110 ? LV.group(n, 100) : [[1, n]]; }
  function epNum(e, i, cur, seen, playing) {
    return '<button class="epn' + (cur ? ' cur' : '') + (seen ? ' seen' : '') + '" data-ep="' + i + '" title="第 ' + e.index + ' 集' + (e.duration ? ' · ' + LV.time(e.duration) : '') + '">' +
      (cur && playing ? '<i class="eq"><b></b><b></b><b></b></i>' : '') + '<span>' + e.index + '</span></button>';
  }
  function epSk(n) { return Array.from({ length: n }, function () { return '<div class="epn sk skel"></div>'; }).join(''); }
  function epTabs(G, gi, attr) { return G.length > 1 ? '<div class="eptabs">' + G.map(function (g, i) { return '<button class="' + (i === gi ? 'on' : '') + '" ' + attr + '="' + i + '">' + g[0] + '–' + g[1] + '</button>'; }).join('') + '</div>' : ''; }
  async function detail(id) {
    var s = cache[id] || {}, p0 = progressOf(id), warmVid0 = (p0 && p0.vid) || s.firstVid || ''; title(s.title || '');
    if (warmVid0) playInfo(warmVid0, LV.get('quality')).catch(function () {});
    var root = mount('<div class="dpage"><button class="dback" data-back>' + ic('back') + '<span>返回</span></button>' +
      '<section class="dhead"><div class="dposter poster">' + (s.cover ? LV.img(s.cover, s.title, 600, true) : '') + '</div>' +
      '<div class="dinfo">' + (s.title ? '<h1>' + esc(s.title) + '</h1>' : '<div class="skel" style="width:60%;height:44px"></div>') + '<div class="skel t" style="width:40%;margin-top:22px"></div><div class="skel t" style="width:92%;margin-top:22px"></div><div class="skel t" style="width:86%;margin-top:12px"></div><div class="skel t s" style="margin-top:12px"></div><div class="skel" style="width:190px;height:48px;border-radius:12px;margin-top:30px"></div></div></section>' +
      '<section class="dsec"><div class="sh2"><h2>选集</h2></div><div class="epg">' + epSk(30) + '</div></section></div>');
    var r; try { r = await api('/api/detail', { query: { id: id }, ttl: TTL }); } catch (e) { $('.dsec', root).outerHTML = failed(e.message); return; }
    if (stripBase(location.pathname) !== '/detail/' + id) return;
    var d = r.detail, prog = latestProgress(id, r.progress), fav = !!r.favorite, cur = prog ? prog.episodeIndex : -1, n = d.episodes.length;
    if (n === 0) { if (hops > 0) window.history.back(); else go('/'); setTimeout(function () { soonPopup(id); }, 60); return; }   // 未上线：弹窗预约，不进详情
    remember([{ id: id, title: d.title, cover: d.cover, episodes: d.count || n, intro: d.intro, plays: d.plays, category: d.category }]);
    title(d.title);
    var info = { id: id, title: d.title, cover: d.cover, rating: d.rating, tag: d.tag, count: d.count || n, plays: d.plays, category: d.category };
    if (!$('.dposter .im', root)) { $('.dposter', root).innerHTML = LV.img(d.cover, d.title, 600, true); }
    var long = (d.intro || '').length > 120;
    var rv = r.reservation || null, reserved = !!r.reserved;
    var when = rv ? (rv.publishText || (rv.time ? LV.day(rv.time) + ' 上线' : '')) : '';
    function resvBtn() { return reserved
      ? '<button class="btn lg resv on" data-act="resv">' + ic('check') + '<span>已预约</span></button>'
      : '<button class="btn primary lg resv" data-act="resv">' + ic('bell') + '<span>预约</span></button>'; }
    $('.dinfo', root).innerHTML = '<h1>' + esc(d.title) + '</h1>' +
      (n === 0 ? '<div class="dsoon"><span class="tag">待上线</span>' + (when ? '<span>' + esc(when) + '</span>' : '') + '</div>' : '<div class="dmeta">' + metaHtml(info) + '</div>') +
      (d.intro ? '<div class="dintro' + (long ? ' clamp' : '') + '"><p>' + esc(d.intro) + '</p>' + (long ? '<button class="more2" data-act="more">展开</button>' : '') + '</div>' : '') +
      (d.actors.length ? '<div class="dcast"><span>主演</span>' + d.actors.slice(0, 6).map(esc).join('<i>/</i>') + '</div>' : '') +
      '<div class="dacts">' +
      // 未上线（没有可播集）→ 预约为主操作，替代「播放」；上线的才显示播放。预约只对未上线的剧/季出现。
      (n === 0
        ? resvBtn()
        : '<button class="btn primary lg" data-act="play">' + ic('play2') + (prog ? '继续观看 第 ' + (cur + 1) + ' 集' : '播放第 1 集') + '</button>') +
      '<button class="btn lg' + (fav ? ' faved' : '') + '" data-act="fav">' + ic(fav ? 'heartfill' : 'heart') + '<span>' + (fav ? '已收藏' : '收藏') + '</span></button>' +
      (n > 0 && LV.caps.download ? '<button class="btn lg" data-act="dl">' + ic('download') + '<span>下载剧集</span></button>' : '') + '</div>';
    var di = $('.dintro.clamp', root); if (di) { var p = $('p', di); if (p.scrollHeight <= p.clientHeight + 2) { di.classList.remove('clamp'); $('.more2', di).remove(); } }
    var warmed = false, targetEp = d.episodes[Math.max(0, cur)];
    if (!PL && targetEp) { warmed = true; playInfo(targetEp.vid, LV.get('quality')).catch(function () {}); }
    $('.dhead', root).addEventListener('pointerover', function (e) { if (!warmed && e.target.closest('[data-act=play]') && d.episodes[Math.max(0, cur)]) { warmed = true; prewarm(d.episodes[Math.max(0, cur)].vid); } });
    $('.dhead', root).addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'more') { var w = a.parentNode, c = w.classList.toggle('clamp'); a.textContent = c ? '展开' : '收起'; return; }
      if (a.dataset.act === 'play') return openPlayer(d, Math.max(0, cur), prog ? prog.positionMs : 0);
      if (a.dataset.act === 'dl') return openDownloadDialog(d);
      if (a.dataset.act === 'resv') {
        if (!LV.loggedIn) return showLogin(function () { route(); });
        var add = !reserved;
        // 取消预约必须二次确认，避免误触
        return (add ? Promise.resolve(true) : confirmBox('取消预约？', '《' + d.title + '》上线后将不再提醒。', '取消预约', true)).then(function (ok) {
          if (!ok) return;
          a.disabled = true;
          return api('/api/reservation', { body: { id: id, add: add } }).then(function () {
            reserved = add; a.outerHTML = resvBtn();
            LV.toast(add ? '已预约' : '已取消预约');
          }, function (er) { a.disabled = false; LV.toast(er.message); });
        });
      }
      if (!LV.loggedIn) return showLogin(function () { route(); });
      var want = !fav; a.disabled = true;
      api('/api/favorite', { body: { id: id, add: want } }).then(function () { fav = want; a.classList.toggle('faved', fav); a.innerHTML = ic(fav ? 'heartfill' : 'heart') + '<span>' + (fav ? '已收藏' : '收藏') + '</span>'; LV.toast(fav ? '已加入收藏' : '已取消收藏'); }, function (e2) { LV.toast(e2.message); }).then(function () { a.disabled = false; });
    });
    var G = epGroups(n), gi = cur > 0 && G.length > 1 ? Math.floor(cur / 100) : 0, sec = $('.dsec', root);
    function progressChanged(e) { if (!e.detail || e.detail.seriesId !== id) return; prog = e.detail; cur = prog.episodeIndex; gi = cur > 0 && G.length > 1 ? Math.floor(cur / 100) : 0; var button = $('[data-act=play]', root); if (button) button.innerHTML = ic('play2') + '继续观看 第 ' + (cur + 1) + ' 集'; drawEps(false); }
    window.addEventListener('lv:progress', progressChanged); cleanups.push(function () { window.removeEventListener('lv:progress', progressChanged); });
    function drawEps(anim) {
      sec.innerHTML = '<div class="sh2"><h2>选集</h2><span>共 ' + n + ' 集' + (prog ? ' · 上次看到第 ' + (cur + 1) + ' 集' : '') + '</span>' + epTabs(G, gi, 'data-gi') + '</div>' +
        '<div class="epg' + (anim ? ' swap' : '') + '">' + d.episodes.slice(G[gi][0] - 1, G[gi][1]).map(function (e, k) { var i = G[gi][0] - 1 + k; return epNum(e, i, i === cur, i < cur, false); }).join('') + '</div>';
    }
    if (n === 0) { sec.innerHTML = ''; sec.hidden = true; }   // 未上线没有选集，不放空壳（保留节点给季选择器定位）
    else drawEps(false);
    {
      // 多季剧先放占位（季列表第一次要几秒），避免看起来「不能选季」
      var box = null;
      if (d.multiSeason) {
        box = document.createElement('section'); box.className = 'dseasons';
        box.innerHTML = '<div class="sh2"><h2>选择季</h2><span>' + (d.seasonIndex ? '当前第 ' + d.seasonIndex + ' 季' : '') + '</span></div><div class="seasrow">' + [1, 2, 3, 4].map(function () { return '<span class="seachip sk skel"></span>'; }).join('') + '</div>';
        sec.parentNode.insertBefore(box, sec);
      }
      var cachedDetailSeas = seasonsCache.get(id);
      var seasPromise = (cachedDetailSeas && Date.now() - cachedDetailSeas.at < 600e3)
        ? Promise.resolve({ seasons: cachedDetailSeas.list })
        : api('/api/seasons', { query: { id: id, quick: '1' }, ttl: TTL }).then(function (sr) {
            var list = (sr && sr.seasons) || [];
            var entry = { at: Date.now(), list: list };
            seasonsCache.set(id, entry);
            list.forEach(function (x) { if (x && x.id) seasonsCache.set(x.id, entry); });
            return sr;
          });
      seasPromise.then(function (sr) {
        var list = (sr && sr.seasons) || [];
        if (stripBase(location.pathname) !== '/detail/' + id) return;
        if (list.length < 2) { if (box) box.remove(); return; }
        if (!box) { box = document.createElement('section'); box.className = 'dseasons'; sec.parentNode.insertBefore(box, sec); }
        box.innerHTML = '<div class="sh2"><h2>选择季</h2><span>共 ' + list.length + ' 季</span></div><div class="seasrow">' +
          list.map(function (se) {
            var cur = String(se.id) === String(id) || (d && d.id && String(se.id) === String(d.id)), soon = !se.episodes;
            return '<button class="seachip' + (cur ? ' on' : '') + (soon ? ' soon' : '') + '" data-sid="' + se.id + '">' +
              '<b>第 ' + se.number + ' 季</b>' + (soon ? '<i>待上线</i>' : '') + '</button>';
          }).join('') + '</div>';
        var on = $('.seachip.on', box), row = $('.seasrow', box); if (on && row.scrollWidth > row.clientWidth) row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
        box.addEventListener('click', function (e) {
          var b = e.target.closest('[data-sid]'); if (!b || b.dataset.sid === id) return;
          if (b.classList.contains('soon')) soonPopup(b.dataset.sid); else go('/detail/' + b.dataset.sid);
        });
      }).catch(function () { if (box) box.remove(); });
    }
    sec.addEventListener('click', function (e) {
      var g = e.target.closest('[data-gi]'), ep = e.target.closest('[data-ep]');
      if (g && +g.dataset.gi !== gi) { gi = +g.dataset.gi; drawEps(true); }
      else if (ep) { var i = +ep.dataset.ep; openPlayer(d, i, prog && i === cur ? prog.positionMs : 0); }
    });
    ready(); onScroll();
  }


  // ------------------------------------------------------------ 我的
  // 资料行（无卡片）+ 页签（观看历史 / 收藏 / 预约）同页切换，记录可直接删除
  function histCard(c, i, del) {   // 历史卡：海报 + 进度条 + 看到第几集，点击直接续播
    var pr = c.episodeCount ? Math.min(1, ((c.episodeIndex || 0) + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
    return '<button class="card rise" style="--i:' + Math.min(i, 17) + '" data-cw="' + c.seriesId + '"><div class="poster">' + LV.img(c.cover, c.title, 360) +
      '<div class="cwpb"><i style="width:' + pr * 100 + '%"></i></div>' + (del ? '<span class="x" data-x="history" data-t="' + esc(c.title) + '" title="删除记录">' + ic('close') + '</span>' : '') + '</div>' +
      '<div class="t">' + esc(c.title) + '</div><div class="s">看到第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' · 共 ' + c.episodeCount + ' 集' : '') + '</div></button>';
  }
  function rsvWhen(c) {   // 待上线：有预计时间就写时间，没有就只写「待上线」
    if (c.online) return '已上线';
    if (c.publishText) return c.publishText;
    if (c.time) return LV.day(c.time) + ' 上线';
    return '待上线';
  }
  function rsvCard(c, i) {
    var h = card({ id: c.seriesId, title: c.title, cover: c.cover, episodes: c.online ? c.episodeCount : 0 }, { i: i, nobadge: true });
    if (!c.online) h = h.replace('data-id="', 'data-soon="');
    return '<div class="rsv' + (c.online ? ' on' : ' soon') + '">' + h +
      '<span class="soon-tag' + (c.online ? ' live' : '') + '">' + esc(rsvWhen(c)) + '</span></div>';
  }
  function favCard(c, i, del) { var x = card({ id: c.seriesId, title: c.title, cover: c.cover, episodes: c.episodeCount }, { i: i, sub: '', x: del ? 'fav' : '' }); return del ? x.replace('data-x="fav"', 'data-x="fav" data-t="' + esc(c.title) + '"') : x; }
  function mine(kind) {
    var META = {
      fav: { title: '我的收藏', icon: 'heart', emptyTitle: '还没有收藏短剧', emptySub: '在详情页或刷剧时点击收藏，喜欢的剧会出现在这里' },
      history: { title: '观看历史', icon: 'clock', emptyTitle: '还没有观看记录', emptySub: '观看任意剧集后，进度会自动保存在这里' },
      reserve: { title: '我的预约', icon: 'bell', emptyTitle: '还没有预约短剧', emptySub: '待上线的新剧可以在详情或推荐中点击预约' }
    };
    var cur = META[kind] ? kind : 'history', meta = META[cur];
    title(meta.title);
    var guest = !LV.loggedIn, data = {}, err = {}, limited = {}, uncertain = {}, inf = null;
    function descText() {
      if (cur === 'history') return guest ? '观看记录保存在本机，登录后可云端跨设备同步' : '云端同步最近观看进度，点击卡片即可从断点续播';
      if (cur === 'fav') return guest ? '登录后可查看与同步你在红果账号收藏的全部短剧' : '你收藏的短剧与追剧列表，点击封面继续观看';
      return guest ? '登录后可管理即将上线的新剧预约与上线提醒' : '已预约的待上线新剧，上线后将在此标亮提示';
    }
    function headActions() {
      var h = '';
      if (cur === 'history') {
        if (data.history && data.history.length) h += '<button class="btn" type="button" data-clear-all-hist>' + ic('trash') + '清空记录</button>';
        if (guest) h += '<button class="btn primary" type="button" data-login>' + ic('user') + '登录同步</button>';
      } else {
        if (guest) h += '<button class="btn primary" type="button" data-login>' + ic('user') + '立即登录</button>';
        else h += '<button class="btn" type="button" data-mine-refresh>' + ic('refresh') + '刷新</button>';
      }
      return h;
    }
    var root = mount('<div class="minep">' +
      '<header class="mine-head" data-kind="' + cur + '">' +
        '<div class="mine-hl"><span class="mine-ico">' + ic(meta.icon) + '</span>' +
        '<div class="mine-meta"><div class="mine-title-row"><h1>' + meta.title + '</h1><span class="mine-cnt" data-cnt>—</span></div>' +
        '<p class="mine-desc">' + descText() + '</p></div></div>' +
        '<div class="mine-acts" data-macts>' + headActions() + '</div>' +
      '</header>' +
      '<div id="mc"><div class="grid">' + gridSk(2) + '</div></div></div>');

    function drawHeadState() {
      var cntEl = $('[data-cnt]', root), actsEl = $('[data-macts]', root), list = data[cur];
      if (cntEl) {
        cntEl.textContent = (guest && cur !== 'history') ? '需登录'
          : (err[cur] || uncertain[cur] || !list) ? '—'
          : (list.length + (limited[cur] ? '+' : '') + ' 部');
      }
      if (actsEl) actsEl.innerHTML = headActions();
    }
    function cardOf(k) { return k === 'history' ? function (c, i) { return histCard(c, i, true); } : k === 'fav' ? function (c, i) { return favCard(c, i, true); } : rsvCard; }
    function draw() {
      if (inf) { inf.stop(); inf = null; }
      var mc = $('#mc', root), list = data[cur];
      drawHeadState();
      if (guest && cur !== 'history') {
        mc.innerHTML = empty(meta.icon, '登录后查看' + meta.title, '登录红果账号即可跨设备同步收藏与预约', '<div class="mine-empty-acts"><button class="btn primary" type="button" data-login>立即登录</button><a class="btn" href="/">去首页看看</a></div>');
        return;
      }
      if (err[cur]) { mc.innerHTML = failed(err[cur]); return; }
      if (!list) { mc.innerHTML = '<div class="grid">' + gridSk(2) + '</div>'; return; }
      if (!list.length) { mc.innerHTML = empty(meta.icon, meta.emptyTitle, meta.emptySub, '<a class="btn" href="/">去首页看看</a>'); return; }
      mc.innerHTML = '<div class="grid" id="mg"></div><div class="sentinel" id="msent"></div>';
      var g = $('#mg', mc), at = 0, render = cardOf(cur), k = cur;
      function more() { var part = list.slice(at, at + 36); at += part.length; g.insertAdjacentHTML('beforeend', part.map(function (c, i) { return render(c, i); }).join('')); return at < list.length; }
      if (more()) { inf = LV.infinite($('#msent', mc), async function () { return cur === k && more(); }, { host: g, skel: function () { return ''; } }); cleanups.push(inf.stop); }
      ready();
    }
    function load(k, url, pick) {
      return api(url, k === 'history' && guest ? { ttl: TTL } : undefined).then(function (r) {
        var list = pick(r) || []; data[k] = list; err[k] = null; limited[k] = k === 'history' ? list.length >= 300 : k === 'reserve' ? !!r.limited : false;
        uncertain[k] = k === 'reserve' && !!r.partial;
        if (k === 'history') { ++historyRequest; hist = mergeRecentHistory(list); historyLoaded = true; data[k] = hist; }
        remember(list.map(function (c) { return { id: c.seriesId, title: c.title, cover: c.cover, episodes: c.episodeCount }; }));
      }, function (e) { err[k] = e.message; }).then(function () { if (!root.isConnected) return; drawHeadState(); if (cur === k) draw(); });
    }
    function reloadCur() {
      if (cur === 'history') load('history', guest ? '/api/history' : '/api/history?fresh=1', function (r) { return r && r.items; });
      else if (cur === 'fav' && !guest) load('fav', '/api/favorites', function (r) { return r.items; });
      else if (cur === 'reserve' && !guest) load('reserve', '/api/reservations', function (r) { return (r.upcoming || []).concat(r.online || []); });
      else draw();
    }
    reloadCur();

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-mine-refresh]')) {
        data[cur] = null; err[cur] = null; draw(); reloadCur();
      } else if (e.target.closest('[data-clear-all-hist]')) {
        var list = data.history || [];
        if (!list.length) return;
        confirmBox('清空观看历史？', '将删除全部 ' + list.length + ' 条观看记录，此操作无法撤销。', '清空记录', true).then(function (ok) {
          if (!ok) return;
          Promise.all(list.map(function (c) { return api('/api/history/delete', { body: { id: c.seriesId } }).catch(function () {}); })).then(function () {
            hist = []; data.history = []; recentPlayback.clear(); saveCachedHist(); draw(); LV.toast('观看历史已清空');
          });
        });
      }
    });

    function patchHistoryGrid(list) {
      var g = $('#mg', root);
      if (!g || !list || !list.length) return false;
      var render = cardOf('history');
      var existing = new Map();
      $$(':scope > [data-cw]', g).forEach(function (node) { existing.set(node.dataset.cw, node); });
      if (!existing.size) return false;
      var shownCount = Math.max(existing.size, Math.min(36, list.length));
      var slice = list.slice(0, shownCount);
      var keep = new Set();
      var ordered = slice.map(function (c, i) {
        keep.add(c.seriesId);
        var pr = c.episodeCount ? Math.min(1, (c.episodeIndex + (c.positionMs > 0 ? 0.5 : 0)) / c.episodeCount) : 0;
        var subText = '看到第 ' + ((c.episodeIndex || 0) + 1) + ' 集' + (c.episodeCount ? ' · 共 ' + c.episodeCount + ' 集' : '');
        var node = existing.get(c.seriesId);
        if (node) {
          var bar = $('.cwpb i', node); if (bar) bar.style.width = (pr * 100) + '%';
          var t = $('.t', node); if (t && c.title && t.textContent !== c.title) t.textContent = c.title;
          var s = $('.s', node); if (s && s.textContent !== subText) s.textContent = subText;
          return node;
        }
        var tmp = document.createElement('div');
        tmp.innerHTML = render(c, i);
        node = tmp.firstElementChild;
        if (node) node.classList.add('cw-new');
        return node;
      }).filter(Boolean);
      existing.forEach(function (node, id) { if (!keep.has(id)) node.remove(); });
      ordered.forEach(function (node, idx) {
        var curNode = g.children[idx];
        if (curNode !== node) g.insertBefore(node, curNode || null);
      });
      return true;
    }
    function syncHistory(e) {
      if (!root.isConnected) return;
      data.history = e.detail && e.detail.seriesId ? mergeRecentHistory([e.detail].concat(data.history || [])) : (e.detail || hist);
      limited.history = data.history.length >= 300; err.history = null; drawHeadState();
      if (cur === 'history' && !patchHistoryGrid(data.history)) draw();
    }
    function libraryChanged(e) {
      if (!root.isConnected || guest) return;
      if (e.detail === 'fav' && cur === 'fav') load('fav', '/api/favorites', function (r) { return r.items; });
      if (e.detail === 'reserve' && cur === 'reserve') load('reserve', '/api/reservations', function (r) { return (r.upcoming || []).concat(r.online || []); });
    }
    window.addEventListener('lv:history', syncHistory); window.addEventListener('lv:progress', syncHistory); window.addEventListener('lv:library-changed', libraryChanged);
    mineRemoved = function (id, isHist) {
      var k = isHist ? 'history' : 'fav'; if (!data[k]) return;
      data[k] = data[k].filter(function (c) { return c.seriesId !== id; }); drawHeadState();
      if (cur === k && !data[k].length) draw();
    };
    cleanups.push(function () { mineRemoved = null; window.removeEventListener('lv:history', syncHistory); window.removeEventListener('lv:progress', syncHistory); window.removeEventListener('lv:library-changed', libraryChanged); });
  }
  var mineRemoved = null;
  async function removeItem(x) {
    var c = x.closest('[data-id],[data-cw]'), id = c.dataset.id || c.dataset.cw, isHist = x.dataset.x === 'history', t = x.dataset.t || '';
    // 删除记录 / 取消收藏都要二次确认（和取消预约一样）
    var ok = await confirmBox(isHist ? '删除这条观看记录？' : '取消收藏？', (t ? '《' + t + '》' : '') + (isHist ? (!LV.loggedIn ? '将从本地观看历史中删除。' : '将从观看历史中删除，并同步到红果 App。') : '将从收藏中移除，并同步到红果 App。'), isHist ? '删除' : '取消收藏', true);
    if (!ok) return;
    try {
      if (isHist) await api('/api/history/delete', { body: { id: id } }); else await api('/api/favorite', { body: { id: id, add: false } });
      c.style.transition = 'transform .45s var(--ease),opacity .3s'; c.style.transform = 'scale(.85)'; c.style.opacity = 0;
      setTimeout(function () { var row = c.parentNode; c.remove(); if (row && row.classList.contains('row')) arrState(row); }, 360);
      if (isHist) {
        hist = hist.filter(function (h) { return h.seriesId !== id; });
        recentPlayback.delete(id);
        saveCachedHist();
      }
      if (mineRemoved) setTimeout(function () { if (mineRemoved) mineRemoved(id, isHist); }, 380);
      LV.toast(isHist ? '已删除' : '已取消收藏');
    } catch (e) { LV.toast(e.message); }
  }

  // ------------------------------------------------------------ 下载管理（桌面高级能力）
  function fmtBytes(n) {
    n = +n || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function openDownloadDialog(d) {
    var w = document.createElement('div'); w.className = 'cfm';
    var selected = Object.create(null);
    d.episodes.forEach(function (ep) { selected[ep.vid] = true; });
    var total = d.episodes.length;
    w.innerHTML = '<div class="cfm-card dl-dlg-card"><h3>批量下载 · ' + esc(d.title) + '</h3>' +
      '<p>多线程断点续传，加密剧集自动解密保存至本地</p>' +
      '<div class="dl-dlg-bar"><div class="dl-acts"><button type="button" class="btn sm" data-sel="all">全选</button><button type="button" class="btn sm" data-sel="none">全不选</button></div><span class="dl-dlg-cnt"></span></div>' +
      '<div class="dl-ep-grid">' + d.episodes.map(function (ep) {
        return '<button type="button" data-dlvid="' + esc(ep.vid) + '" class="on">第' + ep.index + '集</button>';
      }).join('') + '</div>' +
      '<div class="cfm-acts"><button type="button" class="btn" data-c="0">取消</button><button type="button" class="btn primary" data-c="1"></button></div></div>';
    var cntEl = $('.dl-dlg-cnt', w), goBtn = $('[data-c="1"]', w), epBtns = $$('[data-dlvid]', w);
    var cnt = total;
    function syncCounts() {
      if (cntEl) cntEl.textContent = '已选 ' + cnt + ' / ' + total + ' 集';
      if (goBtn) goBtn.textContent = '开始下载 (' + cnt + ')';
    }
    syncCounts();
    (document.fullscreenElement || document.body).appendChild(w);
    requestAnimationFrame(function () { w.classList.add('on'); });
    function close() { w.classList.remove('on'); setTimeout(function () { w.remove(); }, 200); }
    w.addEventListener('click', function (e) {
      if (e.target === w || e.target.closest('[data-c="0"]')) return close();
      var sb = e.target.closest('[data-sel]');
      if (sb) {
        var allOn = sb.dataset.sel === 'all';
        epBtns.forEach(function (btn) {
          selected[btn.dataset.dlvid] = allOn;
          btn.classList.toggle('on', allOn);
        });
        cnt = allOn ? total : 0;
        syncCounts();
        return;
      }
      var eb = e.target.closest('[data-dlvid]');
      if (eb) {
        var vid = eb.dataset.dlvid;
        var next = !selected[vid];
        selected[vid] = next;
        eb.classList.toggle('on', next);
        cnt += next ? 1 : -1;
        syncCounts();
        return;
      }
      if (e.target.closest('[data-c="1"]')) {
        var items = d.episodes.filter(function (ep) { return selected[ep.vid]; }).map(function (ep) {
          return { seriesId: d.id, seriesTitle: d.title, cover: d.cover, vid: ep.vid, episodeIndex: ep.index, episodeTitle: ep.title, definition: LV.get('quality') };
        });
        if (!items.length) return LV.toast('请至少选择一集');
        api('/api/download/add-batch', { body: { items: items } }).then(function (r) {
          close();
          LV.toast('已加入 ' + (r.count || items.length) + ' 个下载任务');
        }, function (er) { LV.toast(er.message); });
      }
    });
  }

  function downloadsPage() {
    title('下载管理');
    var root = mount('<div class="dlp">' +
      '<header class="dl-head">' +
        '<div class="dl-hl">' +
        '<div class="dl-hmeta"><div class="dl-title-row"><h1>下载管理</h1><span class="dl-stats" id="dl-stats"></span></div>' +
        '<p class="dl-desc">进行中 <b data-dlm="active">0</b> · 已完成 <b data-dlm="done">0</b> · 速率 <b data-dlm="speed">空闲</b></p></div></div>' +
        '<div class="dl-acts"><button class="btn sm" type="button" data-dlopenroot title="打开本地下载文件夹">' + ic('folder') + '<span>下载目录</span></button></div>' +
      '</header>' +
      '<div class="dl-bar">' +
        '<div class="dl-tabs" role="tablist"><button type="button" class="on" data-dltab="active">正在下载 (0)</button><button type="button" data-dltab="done">已完成 (0)</button></div>' +
        '<div class="dl-acts">' +
          '<button class="btn sm primary" type="button" data-dlact="resume_all">全部开始</button>' +
          '<button class="btn sm" type="button" data-dlact="pause_all">全部暂停</button>' +
          '<button class="btn sm" type="button" data-dlact="clear_completed">清理已完成</button>' +
          '<button class="btn sm danger" type="button" data-dldel-sel hidden>删除已选 (0)</button>' +
        '</div>' +
      '</div>' +
      '<div class="dl-list" id="dl-list"></div></div>');
    var listEl = $('#dl-list', root), statsEl = $('#dl-stats', root), alive = true, timer = 0;
    var mActive = $('[data-dlm="active"]', root), mDone = $('[data-dlm="done"]', root), mSpeed = $('[data-dlm="speed"]', root);
    var curTab = 'active', userPickedTab = false, expanded = Object.create(null), selected = Object.create(null);
    var lastItems = [];
    var STATUS_TXT = { queued: '排队中', downloading: '下载中', paused: '已暂停', completed: '已完成', failed: '失败', canceled: '已取消' };

    function groupItems(items, onlyDone) {
      var groups = [], bySid = Object.create(null);
      items.forEach(function (t) {
        var isDone = t.status === 'completed';
        if (onlyDone ? !isDone : isDone) return;
        var sid = t.seriesId || t.id;
        var g = bySid[sid];
        if (!g) {
          g = { seriesId: sid, title: t.seriesTitle || sid, cover: t.cover || '', items: [], doneCount: 0, activeCount: 0, totalBytes: 0, downloadedBytes: 0, speed: 0 };
          bySid[sid] = g;
          groups.push(g);
        }
        g.items.push(t);
        if (isDone) g.doneCount++;
        if (t.status === 'downloading' || t.status === 'queued') g.activeCount++;
        g.totalBytes += (+t.totalBytes || 0);
        g.downloadedBytes += (+t.downloadedBytes || 0);
        if (t.status === 'downloading') g.speed += (+t.speedBytesPerSec || 0);
      });
      groups.forEach(function (g) { g.items.sort(function (a, b) { return (+a.episodeIndex || 0) - (+b.episodeIndex || 0); }); });
      return groups;
    }

    function syncToolbar(items) {
      var activeN = 0, doneN = 0, totalSpeed = 0;
      var valid = Object.create(null);
      items.forEach(function (t) {
        valid[t.id] = 1;
        if (t.status === 'completed') doneN++; else activeN++;
        if (t.status === 'downloading') totalSpeed += (+t.speedBytesPerSec || 0);
      });
      Object.keys(selected).forEach(function (k) { if (!valid[k]) delete selected[k]; });
      var tbA = $('[data-dltab="active"]', root), tbD = $('[data-dltab="done"]', root);
      if (tbA) { tbA.textContent = '正在下载 (' + activeN + ')'; tbA.classList.toggle('on', curTab === 'active'); }
      if (tbD) { tbD.textContent = '已完成 (' + doneN + ')'; tbD.classList.toggle('on', curTab === 'done'); }
      if (statsEl) statsEl.textContent = totalSpeed > 0 ? ('总速度 ' + fmtBytes(totalSpeed) + '/s') : '';
      if (mActive) mActive.textContent = activeN;
      if (mDone) mDone.textContent = doneN;
      if (mSpeed) mSpeed.textContent = totalSpeed > 0 ? (fmtBytes(totalSpeed) + '/s') : '空闲';
      var selCount = Object.keys(selected).filter(function (k) { return selected[k]; }).length;
      var delSelBtn = $('[data-dldel-sel]', root);
      if (delSelBtn) {
        delSelBtn.hidden = selCount === 0;
        delSelBtn.textContent = '删除已选 (' + selCount + ')';
      }
    }

    function patchEpRow(epNode, t, g) {
      var epPct = t.totalBytes > 0 ? Math.min(100, Math.round(t.downloadedBytes * 100 / t.totalBytes)) : (t.status === 'completed' ? 100 : 0);
      var epSub = (STATUS_TXT[t.status] || t.status) + ' · ' + fmtBytes(t.downloadedBytes) + (t.totalBytes ? ' / ' + fmtBytes(t.totalBytes) : '') + (t.status === 'downloading' && t.speedBytesPerSec ? ' · ' + fmtBytes(t.speedBytesPerSec) + '/s' : '') + (t.error ? ' · ' + t.error : '');
      var epBtns = (t.status === 'completed'
          ? '<button class="btn sm icon-only primary" data-dlplay="' + esc(t.seriesId || g.seriesId) + '" data-dlep="' + Math.max(0, (+t.episodeIndex || 1) - 1) + '" title="离线播放" aria-label="离线播放">' + ic('play2') + '</button>'
          : ((t.status === 'downloading' || t.status === 'queued')
              ? '<button class="btn sm icon-only" data-dltask="pause" data-dlid="' + esc(t.id) + '" title="暂停下载" aria-label="暂停下载">' + ic('pause') + '</button>'
              : '<button class="btn sm icon-only primary" data-dltask="resume" data-dlid="' + esc(t.id) + '" title="继续下载" aria-label="继续下载">' + ic('play2') + '</button>')) +
        '<button class="btn sm icon-only soft-danger" data-dltask="delete" data-dlid="' + esc(t.id) + '" title="删除任务" aria-label="删除任务">' + ic('trash') + '</button>';
      var chk = $('[data-dlchk]', epNode);
      if (chk) chk.checked = !!selected[t.id];
      var bEl = $('.dl-info b', epNode), targetTitle = '第 ' + t.episodeIndex + ' 集（' + (t.definition || '1080p') + '）';
      if (bEl && bEl.textContent !== targetTitle) bEl.textContent = targetTitle;
      var sEl = $('.dl-info small', epNode);
      if (sEl && sEl.textContent !== epSub) sEl.textContent = epSub;
      var barEl = $('.dl-prog i', epNode), wStr = epPct + '%';
      if (barEl && barEl.style.width !== wStr) barEl.style.width = wStr;
      var btnsEl = $('.dl-btns', epNode);
      if (btnsEl && btnsEl.dataset.sig !== epBtns) { btnsEl.dataset.sig = epBtns; btnsEl.innerHTML = epBtns; }
    }

    function buildGroupNode(g) {
      var wrap = document.createElement('div');
      wrap.className = 'dl-group';
      wrap.dataset.dlgroup = g.seriesId;
      wrap.dataset.dlcover = g.cover || '';
      wrap.innerHTML = '<div class="dl-ghead" data-dlexpand="' + esc(g.seriesId) + '">' +
        '<div class="dl-cov poster">' + (g.cover ? LV.img(g.cover, g.title, 160, true) : '') + '</div>' +
        '<div class="dl-info"><div class="dl-gtitle"><b></b><span class="dl-tag"></span><span class="dl-gpct"></span></div>' +
        '<small></small></div>' +
        '<div class="dl-btns"></div></div>';
      return wrap;
    }

    function patchGroupNode(node, g) {
      var open = !!expanded[g.seriesId];
      var pct = g.totalBytes > 0 ? Math.min(100, Math.round(g.downloadedBytes * 100 / g.totalBytes)) : (g.doneCount === g.items.length ? 100 : 0);
      var hasCompleted = g.doneCount > 0;
      var hasPauseable = g.activeCount > 0;
      var hasResumable = g.items.some(function (t) { return t.status === 'paused' || t.status === 'failed' || t.status === 'canceled'; });
      var sub = '共 ' + g.items.length + ' 集 · ' + (curTab === 'done' ? '已全部解密保存' : ('已完成 ' + g.doneCount + ' 集')) +
        (g.totalBytes ? ' · ' + fmtBytes(g.downloadedBytes) + ' / ' + fmtBytes(g.totalBytes) : (g.downloadedBytes ? ' · ' + fmtBytes(g.downloadedBytes) : '')) +
        (g.speed > 0 ? ' · ' + fmtBytes(g.speed) + '/s' : '');
      var openTargetId = (g.items.find(function (x) { return x.status === 'completed'; }) || g.items[0]).id;
      var primaryBtn = curTab === 'done' && hasCompleted
        ? '<button class="btn sm icon-only primary" data-dlplay="' + esc(g.seriesId) + '" data-dlep="' + Math.max(0, (g.items.find(function (x) { return x.status === 'completed'; }) || g.items[0]).episodeIndex - 1) + '" title="离线播放" aria-label="离线播放">' + ic('play2') + '</button>'
        : (hasPauseable
            ? '<button class="btn sm icon-only" data-dlgrp="pause" data-dlsid="' + esc(g.seriesId) + '" title="全部暂停" aria-label="全部暂停">' + ic('pause') + '</button>'
            : (hasResumable
                ? '<button class="btn sm icon-only primary" data-dlgrp="resume" data-dlsid="' + esc(g.seriesId) + '" title="继续下载" aria-label="继续下载">' + ic('play2') + '</button>'
                : (hasCompleted ? '<button class="btn sm icon-only primary" data-dlplay="' + esc(g.seriesId) + '" data-dlep="' + Math.max(0, (g.items.find(function (x) { return x.status === 'completed'; }) || g.items[0]).episodeIndex - 1) + '" title="离线播放" aria-label="离线播放">' + ic('play2') + '</button>' : '')));
      var gBtns = primaryBtn +
        '<button class="btn sm icon-only" data-dlopen="' + esc(openTargetId) + '" title="打开所在目录" aria-label="打开所在目录">' + ic('folder') + '</button>' +
        '<button class="btn sm icon-only soft-danger" data-dlgrp="delete" data-dlsid="' + esc(g.seriesId) + '" title="删除整剧缓存" aria-label="删除整剧缓存">' + ic('trash') + '</button>';

      if ((node.dataset.dlcover || '') !== (g.cover || '')) {
        node.dataset.dlcover = g.cover || '';
        var covEl = $('.dl-cov', node);
        if (covEl) covEl.innerHTML = g.cover ? LV.img(g.cover, g.title, 160, true) : '';
      }
      var titleEl = $('.dl-gtitle b', node);
      if (titleEl && titleEl.textContent !== g.title) titleEl.textContent = g.title;
      var tagEl = $('.dl-tag', node), tagTxt = open ? '收起分集' : ('共 ' + g.items.length + ' 集');
      if (tagEl) {
        tagEl.classList.toggle('done', curTab === 'done');
        if (tagEl.textContent !== tagTxt) tagEl.textContent = tagTxt;
      }
      var subEl = $('.dl-ghead > .dl-info > small', node);
      if (subEl && subEl.textContent !== sub) subEl.textContent = sub;
      var pctEl = $('.dl-gpct', node), pctTxt = pct + '%';
      if (pctEl && pctEl.textContent !== pctTxt) pctEl.textContent = pctTxt;
      var btnsEl = $('.dl-ghead > .dl-btns', node);
      if (btnsEl && btnsEl.dataset.sig !== gBtns) { btnsEl.dataset.sig = gBtns; btnsEl.innerHTML = gBtns; }

      var geps = $('.dl-geps', node);
      if (!open) {
        if (geps) geps.remove();
        return;
      }
      if (!geps) {
        geps = document.createElement('div');
        geps.className = 'dl-geps';
        node.appendChild(geps);
      }
      var existingEps = new Map();
      $$(':scope > .dl-ep[data-dlepid]', geps).forEach(function (epNode) { existingEps.set(epNode.dataset.dlepid, epNode); });
      var keepEps = new Set();
      var orderedEps = g.items.map(function (t) {
        keepEps.add(t.id);
        var epNode = existingEps.get(t.id);
        if (!epNode) {
          epNode = document.createElement('div');
          epNode.className = 'dl-ep';
          epNode.dataset.dlepid = t.id;
          epNode.innerHTML = '<input type="checkbox" data-dlchk="' + esc(t.id) + '" aria-label="选中">' +
            '<div class="dl-info"><b></b><small></small><div class="dl-prog"><i></i></div></div>' +
            '<div class="dl-btns"></div>';
        }
        patchEpRow(epNode, t, g);
        return epNode;
      });
      existingEps.forEach(function (epNode, id) { if (!keepEps.has(id)) epNode.remove(); });
      orderedEps.forEach(function (epNode, idx) {
        if (geps.children[idx] !== epNode) geps.insertBefore(epNode, geps.children[idx] || null);
      });
    }

    function render(items) {
      lastItems = items || [];
      if (!userPickedTab && curTab === 'active') {
        var hasAct = lastItems.some(function (t) { return t.status !== 'completed'; });
        var hasDn = lastItems.some(function (t) { return t.status === 'completed'; });
        if (!hasAct && hasDn) curTab = 'done';
      }
      syncToolbar(lastItems);
      var groups = groupItems(lastItems, curTab === 'done');
      if (!groups.length) {
        listEl.innerHTML = empty('download', curTab === 'done' ? '暂无已完成剧集' : '暂无进行中的下载任务', '可在剧集详情页点击「下载剧集」添加到离线队列', '<a class="btn" href="/">去首页逛逛</a>');
        return;
      }
      var existing = new Map();
      $$(':scope > .dl-group[data-dlgroup]', listEl).forEach(function (node) { existing.set(node.dataset.dlgroup, node); });
      if (!existing.size) listEl.innerHTML = '';
      var keep = new Set();
      var ordered = groups.map(function (g) {
        keep.add(g.seriesId);
        var node = existing.get(g.seriesId) || buildGroupNode(g);
        patchGroupNode(node, g);
        return node;
      });
      existing.forEach(function (node, sid) { if (!keep.has(sid)) node.remove(); });
      ordered.forEach(function (node, idx) {
        if (listEl.children[idx] !== node) listEl.insertBefore(node, listEl.children[idx] || null);
      });
    }

    async function refresh() {
      try {
        var r = await api('/api/download/list');
        if (!alive || !root.isConnected) return;
        render(r.items || []);
      } catch (e) { if (alive) listEl.innerHTML = failed(e.message); }
    }

    root.addEventListener('change', function (e) {
      var chk = e.target.closest('[data-dlchk]');
      if (chk) { selected[chk.dataset.dlchk] = !!chk.checked; syncToolbar(lastItems); }
    });
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-dlchk]')) return;
      var tb = e.target.closest('[data-dltab]');
      if (tb) { userPickedTab = true; curTab = tb.dataset.dltab; render(lastItems); return; }
      var a = e.target.closest('[data-dlact]'), tk = e.target.closest('[data-dltask]'), op = e.target.closest('[data-dlopen]'), pl = e.target.closest('[data-dlplay]'), grp = e.target.closest('[data-dlgrp]');
      if (e.target.closest('[data-dlopenroot]')) { api('/api/download/open', { body: {} }).catch(function (er) { LV.toast(er.message); }); return; }
      if (e.target.closest('[data-dldel-sel]')) {
        var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
        if (!ids.length) return;
        confirmBox('批量删除 (' + ids.length + ' 集)', '确定移除已选任务并删除对应本地视频及空目录吗？', '删除', true).then(function (ok) {
          if (!ok) return;
          api('/api/download/delete-batch', { body: { ids: ids, removeFile: true } }).then(function (res) { selected = Object.create(null); render((res && res.items) || []); LV.toast('已删除 ' + ids.length + ' 个任务'); }, function (er) { LV.toast(er.message); });
        });
        return;
      }
      if (pl) {
        var sid = pl.dataset.dlplay, epI = +pl.dataset.dlep || 0;
        api('/api/detail', { query: { id: sid, lite: '1' }, ttl: TTL }).then(function (res) {
          if (res && res.detail && res.detail.episodes && res.detail.episodes.length) openPlayer(res.detail, Math.min(epI, res.detail.episodes.length - 1), 0, false);
        }, function (er) { LV.toast(er.message); });
        return;
      }
      if (grp) {
        var gAct = grp.dataset.dlgrp, gSid = grp.dataset.dlsid;
        var gItems = lastItems.filter(function (t) { return (t.seriesId || t.id) === gSid && (curTab === 'done' ? t.status === 'completed' : t.status !== 'completed'); });
        if (gAct === 'delete') {
          confirmBox('删除整剧缓存', '确定移除该剧下的 ' + gItems.length + ' 个任务并清空本地目录吗？', '删除', true).then(function (ok) {
            if (!ok) return;
            api('/api/download/delete-batch', { body: { ids: gItems.map(function (x) { return x.id; }), removeFile: true } }).then(function (res) { render((res && res.items) || []); LV.toast('已清空剧集下载'); }, function (er) { LV.toast(er.message); });
          });
        } else {
          Promise.all(gItems.map(function (x) { return api('/api/download/action', { body: { action: gAct, id: x.id } }); })).then(refresh, function (er) { LV.toast(er.message); });
        }
        return;
      }
      if (a) { api('/api/download/action', { body: { action: a.dataset.dlact } }).then(refresh, function (er) { LV.toast(er.message); }); return; }
      if (tk) { api('/api/download/action', { body: { action: tk.dataset.dltask, id: tk.dataset.dlid, removeFile: tk.dataset.dltask === 'delete' } }).then(refresh, function (er) { LV.toast(er.message); }); return; }
      if (op) { api('/api/download/open', { body: { id: op.dataset.dlopen } }).catch(function (er) { LV.toast(er.message); }); return; }
      var ex = e.target.closest('[data-dlexpand]');
      if (ex && !e.target.closest('.dl-btns')) { expanded[ex.dataset.dlexpand] = !expanded[ex.dataset.dlexpand]; render(lastItems); }
    });
    refresh();
    timer = setInterval(function () { if (alive && root.isConnected && !document.hidden) refresh(); }, 1500);
    cleanups.push(function () { alive = false; clearInterval(timer); });
  }

  // ------------------------------------------------------------ 设置
  function settings() {
    title('设置');
    var GROUPS = [['acct', '账号', 'user'], ['play', '播放', 'play2']];
    if (LV.caps.download) GROUPS.push(['dl', '下载', 'download']);
    if (LV.caps.coreUpdate) GROUPS.push(['core', '更新', 'refresh']);
    GROUPS.push(['dm', '弹幕', 'danmaku'], ['look', '外观', 'auto'], ['keys', '快捷键', 'sliders'], ['about', '关于', 'film']);
    function row(t, s, right) { return '<div class="srow"><div class="sl"><b>' + t + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</div>' + (right || '') + '</div>'; }
    function sw(k, t, s) { return row(t, s, '<button class="sw' + (LV.get(k) ? ' on' : '') + '" data-sw="' + k + '" role="switch" aria-checked="' + !!LV.get(k) + '" aria-label="' + t + '"></button>'); }
    function pick(k, t, s, opts) { return row(t, s, seg(opts.map(function (o) { return [String(o[0]), o[1]]; }), String(LV.get(k)), 'data-pk-' + k)); }
    function rg(k, t, mn, mx, st, fmt) { return row(t, '', '<div class="rg"><input type="range" min="' + mn + '" max="' + mx + '" step="' + st + '" value="' + LV.get(k) + '" data-rg="' + k + '" aria-label="' + t + '"><em data-rv="' + k + '">' + fmt(LV.get(k)) + '</em></div>'); }
    var pct = function (v) { return Math.round(v * 100) + '%'; }, mul = function (v) { return (+v).toFixed(1) + 'x'; };
    var coreStatus = null, appUpdate = null, dlSettings = null, activeFlt = 'all';
    function coreBody() {
      var mode = (coreStatus && coreStatus.mode) || 'default';
      var channelHtml = row('更新渠道', '',
        seg([['default', '官方默认'], ['custom', '自建渠道'], ['disabled', '关闭更新']], mode, 'data-coremode')) +
        (mode === 'custom' ? row('更新地址', '', '<input class="dl-in" id="core-custom-url" placeholder="https://your-host/update" value="' + esc((coreStatus && coreStatus.customUrl) || '') + '">') : '');
      var appHtml = '';
      if (appUpdate && appUpdate.hasUpdate) {
        var dlUrl = appUpdate.downloadUrl || appUpdate.releaseUrl || '';
        appHtml = row('软件更新', esc(appUpdate.latestVersion),
          '<div class="dl-acts"><button class="btn" data-appcheck>重新检查</button>' +
          (dlUrl ? '<a class="btn primary" href="' + esc(dlUrl) + '" target="_blank" rel="noopener">下载新版</a>' : '') + '</div>');
      } else {
        var appSub = !appUpdate ? ''
          : (appUpdate.disabled ? '已关闭自动更新' : esc(appUpdate.currentVersion || '3.0.0'));
        appHtml = row('软件更新', appSub, '<button class="btn" data-appcheck>检查更新</button>');
      }
      if (!coreStatus) return channelHtml + appHtml + row('Core 更新', '', '');
      var compSub = coreStatus.restartRequired
        ? esc(coreStatus.stagedVersion || coreStatus.latestVersion) + '（重启生效）'
        : (coreStatus.lastError ? '<span style="color:var(--danger)">' + esc(coreStatus.lastError) + '</span>'
          : (esc(coreStatus.currentVersion || '1.0.0') + (coreStatus.stagedExists ? '（待重启生效）' : '')));
      return channelHtml + appHtml +
        row('Core 更新', compSub, '<div class="dl-acts"><button class="btn primary" data-core="check">检查更新</button>' +
          (coreStatus.stagedExists ? '<button class="btn" data-core="rollback">恢复默认</button>' : '') + '</div>');
    }
    function dlBody() {
      if (!dlSettings) return row('下载配置', '正在读取…', '');
      return row('保存目录', '', '<div class="dl-acts"><input class="dl-in" id="dl-dir" value="' + esc(dlSettings.downloadDir || '') + '"><button class="btn" data-dlopenroot>打开目录</button></div>') +
        row('按剧集自动分目录', '', '<button class="sw' + (dlSettings.createSeriesSubdir !== false ? ' on' : '') + '" id="dl-subdir" role="switch" aria-checked="' + (dlSettings.createSeriesSubdir !== false) + '"></button>') +
        row('同时下载数', '', '<input class="dl-in" style="width:90px" id="dl-conc" type="number" min="1" max="4" value="' + (dlSettings.maxConcurrent || 2) + '">') +
        row('单任务线程数', '', '<input class="dl-in" style="width:90px" id="dl-threads" type="number" min="1" max="8" value="' + (dlSettings.threadsPerTask || 4) + '">') +
        row('限速（KB/s）', '', '<div class="dl-acts"><input class="dl-in" style="width:110px" id="dl-limit" type="number" min="0" value="' + (dlSettings.speedLimitKbps || 0) + '"><button class="btn primary" data-dlsave>保存</button></div>');
    }
    var secFmt = function (v) { return (+v || 0) ? (+v) + '秒' : '关闭'; };
    var gpuSupported = !!(LV.caps.desktop && LV.caps.gpuShaders && LV.supportsGpuEnhancement());
    function groupBody(k) {
      if (k === 'acct') return LV.loggedIn
        ? '<div class="srow"><div class="sav">' + (me.profile && me.profile.avatar ? LV.img(me.profile.avatar, '', 120, true) : '') + '<em>' + esc(((me.profile && me.profile.name) || '红')[0]) + '</em></div><div class="sl"><b>' + esc((me.profile && me.profile.name) || '红果用户') + '</b><small>' + (me.daysLeft >= 0 ? '有效期 ' + me.daysLeft + ' 天' : '已登录') + '</small></div><button class="btn ghost" data-out>退出登录</button></div>'
        : row('未登录', '登录后可同步收藏与观看历史', '<button class="btn primary" data-login>' + ic('user') + '立即登录</button>');
      if (k === 'play') return pick('quality', '默认清晰度', '', [['360p', '360P'], ['540p', '540P'], ['720p', '720P'], ['1080p', '1080P']]) +
        (LV.caps.desktop && LV.caps.nativePlayer ? sw('nativePlayer', '外部播放器 (mpv)', '') : '') +
        (gpuSupported ? sw('gpuAccel', '硬件解码', '') +
          pick('superRes', 'GPU 超分', '', [['off', '关闭'], ['cas', 'CAS 锐化'], ['fsr', 'FSR 超分'], ['anime4k', 'AI 超清']]) +
          pick('frameInterp', '画面补帧', '', [['off', '关闭'], ['smooth', '开启']]) : '') +
        sw('autonext', '自动连播', '') + sw('loopOne', '单集循环', '') + sw('keepRate', '换集保持倍速', '');
      if (k === 'dl') return dlBody();
      if (k === 'core') return coreBody();
      if (k === 'dm') return sw('danmaku', '显示弹幕', '') + pick('dmArea', '显示区域', '', [[0.25, '1/4 屏'], [0.5, '半屏'], [0.75, '3/4 屏'], [1, '全屏']]) +
        rg('dmOpacity', '不透明度', 0.2, 1, 0.05, pct) + rg('dmSpeed', '速度', 0.6, 1.8, 0.1, mul) + rg('dmSize', '字号', 0.7, 1.6, 0.1, pct);
      if (k === 'look') return pick('theme', '主题', '', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']]);
      if (k === 'keys') return '<div class="skeys">' + [['/', '搜索'], ['空格 / K', '播放 / 暂停'], ['← →', '后退 / 前进 10 秒'], ['↑ ↓', '上一集 / 下一集'], ['滚轮', '切换剧集'], ['F', '全屏'], ['M', '静音'], ['D', '弹幕开关'], ['T', '选集弹窗'], ['Esc', '关闭弹窗 / 退出播放']].map(function (x) { return '<div><span>' + x[1] + '</span><kbd>' + x[0] + '</kbd></div>'; }).join('') + '</div>';
      var verTxt = LV.caps.coreVersion ? ('Core ' + LV.caps.coreVersion + (LV.caps.target ? ' · ' + LV.caps.target : '')) : '简洁、轻量的短剧播放器';
      return row(brandName(), verTxt, '');
    }
    var root = mount('<div class="setp-v2">' +
      '<div class="page-top set-top"><h1 class="lt">设置</h1><p class="set-sub">播放偏好、弹幕外观、离线存储与系统选项</p></div>' +
      '<div class="set-list">' +
      (function () {
        var leftSet = { play: 1, dl: 1 }, rightSet = { acct: 1, dm: 1, core: 1, look: 1, about: 1 };
        function renderGrp(g) {
          return '<section class="sgrp' + (g[0] === 'keys' ? ' wide' : '') + '" id="s-' + g[0] + '" data-grp="' + g[0] + '">' +
            '<h2><span class="sgrp-ico">' + ic(g[2]) + '</span><span>' + g[1] + '</span></h2>' +
            '<div class="scard" data-g="' + g[0] + '">' + groupBody(g[0]) + '</div></section>';
        }
        var colL = GROUPS.filter(function (g) { return leftSet[g[0]]; }).map(renderGrp).join('');
        var colR = GROUPS.filter(function (g) { return rightSet[g[0]]; }).map(renderGrp).join('');
        var fullW = GROUPS.filter(function (g) { return !leftSet[g[0]] && !rightSet[g[0]]; }).map(renderGrp).join('');
        return '<div class="set-bento-col">' + colL + '</div><div class="set-bento-col">' + colR + '</div>' + fullW;
      })() +
      '</div></div>');
    function fill(r) { r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%'); }
    $$('[data-rg]', root).forEach(fill); placeSeg(root);
    function redraw(k) { var c = $('[data-g="' + k + '"]', root); if (c) { c.innerHTML = groupBody(k); placeSeg(c); } }
    if (LV.caps.coreUpdate) api('/api/core/update').then(function (s) { coreStatus = s; redraw('core'); }).catch(function () {});
    if (LV.caps.download) api('/api/download/settings').then(function (s) { dlSettings = s; redraw('dl'); }).catch(function () {});
    root.addEventListener('click', function (e) {
      var flt = e.target.closest('[data-sflt]');
      var s = e.target.closest('[data-sw]'), pk = e.target.closest('.seg button'), cm = e.target.closest('[data-coremode]'), co = e.target.closest('[data-core]'), ac = e.target.closest('[data-appcheck]');
      if (flt) {
        activeFlt = flt.dataset.sflt;
        $$('.set-pill', root).forEach(function (b) { b.classList.toggle('on', b.dataset.sflt === activeFlt); });
        var listEl = $('.set-list', root);
        if (listEl) listEl.classList.toggle('single', activeFlt !== 'all');
        $$('.sgrp', root).forEach(function (sec) { sec.hidden = activeFlt !== 'all' && sec.dataset.grp !== activeFlt; });
        placeSeg(root);
      }
      else if (ac) {
        ac.disabled = true;
        api('/api/app/update/check').then(function (r) {
          appUpdate = r; redraw('core');
          LV.toast(r.disabled ? '当前已关闭自动更新' : (r.hasUpdate ? '发现新版客户端 ' + r.latestVersion : '当前客户端已是最新版本'));
        }).catch(function (er) { LV.toast(er.message); }).then(function () { ac.disabled = false; });
      }
      else if (cm) {
        var nextMode = cm.dataset.coremode;
        var customUrl = ($('#core-custom-url', root) || {}).value || (coreStatus && coreStatus.customUrl) || '';
        api('/api/core/update/channel', { body: { mode: nextMode, customUrl: customUrl } }).then(function (st) { coreStatus = st; redraw('core'); LV.toast('更新渠道已保存'); }, function (er) { LV.toast(er.message); });
      }
      else if (co) {
        var actName = co.dataset.core;
        if (actName === 'rollback') {
          api('/api/core/update/rollback', { body: {} }).then(function (st) { coreStatus = st; redraw('core'); LV.toast('已恢复默认 Core，重启后生效'); }, function (er) { LV.toast(er.message); });
        } else {
          var urlInput = $('#core-custom-url', root);
          var p = (coreStatus && coreStatus.mode === 'custom' && urlInput)
            ? api('/api/core/update/channel', { body: { mode: 'custom', customUrl: urlInput.value } })
            : Promise.resolve();
          co.disabled = true;
          p.then(function () { return api('/api/core/update/check', { body: { autoDownload: true } }); })
            .then(function (st) { coreStatus = st; redraw('core'); LV.toast(st.restartRequired ? '已下载新版 Core ' + st.stagedVersion + '，重启生效' : '当前 Core 已是最新'); })
            .catch(function (er) { LV.toast(er.message); })
            .then(function () { co.disabled = false; });
        }
      }
      else if (e.target.closest('#dl-subdir')) {
        var subBtn = $('#dl-subdir', root);
        var nextSub = !subBtn.classList.contains('on');
        subBtn.classList.toggle('on', nextSub);
        subBtn.setAttribute('aria-checked', nextSub);
        if (dlSettings) dlSettings.createSeriesSubdir = nextSub;
      }
      else if (e.target.closest('[data-dlopenroot]')) {
        api('/api/download/open', { body: {} }).catch(function (er) { LV.toast(er.message); });
      }
      else if (e.target.closest('[data-dlsave]')) {
        var nextDl = Object.assign({}, dlSettings || {}, {
          downloadDir: ($('#dl-dir', root) || {}).value || '',
          createSeriesSubdir: $('#dl-subdir', root) ? $('#dl-subdir', root).classList.contains('on') : true,
          maxConcurrent: +($('#dl-conc', root) || {}).value || 2,
          threadsPerTask: +($('#dl-threads', root) || {}).value || 4,
          speedLimitKbps: +($('#dl-limit', root) || {}).value || 0
        });
        api('/api/download/settings', { body: nextDl }).then(function (st) { dlSettings = st; redraw('dl'); LV.toast('下载设置已保存'); }, function (er) { LV.toast(er.message); });
      }
      else if (s) { var v = !LV.get(s.dataset.sw); LV.set(s.dataset.sw, v); s.classList.toggle('on', v); s.setAttribute('aria-checked', v); }
      else if (pk) {
        var attr = Array.from(pk.attributes).find(function (a) { return a.name.indexOf('data-pk-') === 0; }); if (!attr) return;
        var k = attr.name.slice(8).replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); }), raw = attr.value, val = isNaN(+raw) ? raw : +raw;
        if (k === 'dmarea') k = 'dmArea';
        LV.set(k, val); $$('button', pk.parentNode).forEach(function (b) { b.classList.toggle('on', b === pk); }); placeSeg(pk.parentNode.parentNode);
      }
      else if (e.target.closest('[data-out]')) logout();
      else if (e.target.closest('[data-login]')) showLogin(function () { route(); });
    });
    root.addEventListener('input', function (e) { var r = e.target.closest('[data-rg]'); if (r) { var k = r.dataset.rg; LV.set(k, +r.value); fill(r); var lab = $('[data-rv="' + k + '"]', root); if (lab) lab.textContent = k === 'dmSpeed' ? (+r.value).toFixed(1) + 'x' : ((k === 'skipIntro' || k === 'skipOutro') ? secFmt(+r.value) : Math.round(r.value * 100) + '%'); } });
  }

  // ------------------------------------------------------------ 播放器（全屏沉浸）
  var rep = new LV.Reporter(), PL = null, afterPlayer = null, OPENING = null, seasonsCache = new Map();
  // Cache successful source discovery briefly; recovery bypasses this cache to force a fresh model.
  function playInfo(vid, q, force) { return api('/api/play', { query: { vid: vid, q: q, fresh: force ? '1' : undefined }, ttl: force ? 0 : 60000 }).then(function (r) { if (r && r.src) r.src = LV.apiUrl(r.src); return r; }); }
  // 预热：取播放地址并让服务端提前下载解密（缓存在服务端），点播放时首帧几乎即到
  function prewarm(vid, q) { playInfo(vid, q || LV.get('quality')).then(function (r) { fetch(r.src, { headers: { Range: 'bytes=0-1' } }).catch(function () {}); }).catch(function () {}); }

  function hideInlinePlayerOverlay() {
    if (PL) return;
    OPENING = null;
    var el = $('#player');
    if (el) { el.hidden = true; el.innerHTML = ''; el.className = ''; }
    if (history.state && history.state.p) {
      try { history.replaceState(null, '', location.href); } catch (_) {}
    }
  }
  function launchStandalonePlayer(playUrl) {
    if (LV.caps.desktop && LV.caps.standalonePlayer) {
      if (window.ipc && typeof window.ipc.postMessage === 'function') {
        window.ipc.postMessage(JSON.stringify({ type: 'openPlayer', url: location.origin + playUrl }));
        hideInlinePlayerOverlay();
        return true;
      }
      var w = window.open(playUrl, 'lvguo_player');
      if (w) {
        hideInlinePlayerOverlay();
        return true;
      }
      return false;
    }
    var tab = window.open(playUrl, '_blank');
    if (tab) {
      try { tab.focus(); } catch (_) {}
      hideInlinePlayerOverlay();
      return true;
    }
    return false;
  }

  // Open immediately while the series metadata is fetched. The same history
  // entry is handed to the real player once the episodes are ready.
  function openSeriesLoader(id) {
    if (PL || OPENING) return;
    if (!isStandalonePlay() && !(LV.caps.desktop && LV.caps.nativePlayer && LV.get('nativePlayer'))) {
      var p0 = progressOf(id);
      var qUrl = '/play?id=' + encodeURIComponent(id);
      if (p0 && p0.episodeIndex >= 0) {
        qUrl += '&ep=' + p0.episodeIndex + '&pos=' + Math.max(0, Math.round(p0.positionMs || 0));
      }
      if (launchStandalonePlayer(fullPath(qUrl))) return;
    }
    closeMenu();var el=$('#player'),info=cache[id]||{},state={id:id,request:0};OPENING=state;
    el.hidden=false;el.className='';el.innerHTML='<div class="amb"><i style="background-image:url(\''+esc(LV.sized(info.cover,200)||'')+'\')"></i><b></b></div><div class="pload"><i></i><span>正在加载</span></div><div class="ui"><div class="shade t"></div><div class="ptop"><button class="cbtn" data-opening-close aria-label="返回">'+ic('back')+'</button><div class="title"><b>'+esc(info.title||'正在加载')+'</b></div></div></div>';
    window.history.pushState({p:1},'');
    function detach(){document.removeEventListener('keydown',key);window.removeEventListener('popstate',pop);el.removeEventListener('click',click)}
    function close(fromPop){if(OPENING!==state)return;OPENING=null;state.request++;detach();if(!fromPop&&history.state&&history.state.p)history.replaceState(null,'',location.href);el.hidden=true;el.innerHTML='';el.className=''}
    function key(e){if(e.key==='Escape'&&!document.fullscreenElement){e.preventDefault();close(false)}}
    function pop(){close(true)}
    function click(e){if(e.target.closest('[data-opening-close]'))close(false);else if(e.target.closest('[data-opening-retry]'))fetchDetail()}
    document.addEventListener('keydown',key);window.addEventListener('popstate',pop);el.addEventListener('click',click);
    function fetchDetail(){
      var n=++state.request,old=$('.perr',el);if(old)old.remove();$('.pload',el).classList.remove('hide');
      var p0=progressOf(id),warmVid=(p0&&p0.vid)||(info&&info.firstVid)||'';
      if(warmVid)playInfo(warmVid,LV.get('quality')).catch(function(){});
      api('/api/detail',{query:{id:id,lite:(historyLoaded||p0)?'1':undefined},ttl:TTL}).then(function(r){
        if(OPENING!==state||n!==state.request)return;
        if(!r.detail||!r.detail.episodes||!r.detail.episodes.length)throw new Error('暂无可播放的剧集');
        var p=latestProgress(id,r.progress);OPENING=null;detach();openPlayer(r.detail,p?p.episodeIndex:0,p?p.positionMs:0,true);
      }).catch(function(e){
        if(OPENING!==state||n!==state.request)return;$('.pload',el).classList.add('hide');
        el.insertAdjacentHTML('beforeend','<div class="perr"><div class="box"><button class="perr-close" data-opening-close aria-label="关闭播放器">'+ic('close')+'</button><h3>加载失败</h3><p>'+esc(e.message||'请稍后重试')+'</p><button class="bplay" data-opening-retry>重试</button></div></div>');
      });
    }
    fetchDetail();
  }

  var lastFeedFirstId = '';
  function feedPage() {
    if (PL) return;
    title('刷剧'); closeMenu();
    view.innerHTML = '';
    var el = $('#player'); el.hidden = false; el.className = 'feed';
    el.innerHTML = '<div class="pload"><i></i><span>正在加载</span></div>';
    var aborted = false, items = [], seen = {}, src = 'fy', ch = '16', next = 0, cell = '', sess = '', more = true, dry = 0, pending = null, bq = null, bi = 0, boff = 0, bsess = '';
    // 复用首页已缓存的推荐列表作为首屏种子（先洗牌并避开上次首部），省掉首帧等待，同时后台立即拉一页 /api/foryou 插到第 2 位。
    var seedHome = persist('home');
    if (Array.isArray(seedHome) && seedHome.length) {
      var pool = [];
      seedHome.forEach(function (s) { if (s && s.id && !seen[s.id]) { seen[s.id] = 1; pool.push(s); } });
      for (var si = pool.length - 1; si > 0; si--) {
        var sj = Math.floor(Math.random() * (si + 1));
        var tmp = pool[si]; pool[si] = pool[sj]; pool[sj] = tmp;
      }
      if (pool.length > 1 && pool[0].id === lastFeedFirstId) {
        var swap = pool[0]; pool[0] = pool[1]; pool[1] = swap;
      }
      pool.forEach(function (s) { items.push(s); });
    }
    var seedCount = items.length, promoted = false, bootIndex = 0;
    function fetchMore() {
      if (pending) return pending;
      if (!more) return Promise.resolve();
      var before = items.length, req;
      if (src === 'fy') {
        req = api('/api/foryou', { query: { channel: ch, offset: next, cell: cell || undefined, session: sess || undefined } }).then(function (r) {
          var list = (r && r.page && r.page.items) || [];
          remember(list);
          list.forEach(function (s) { if (s && s.id && !seen[s.id]) { seen[s.id] = 1; items.push(s); } });
          next = r && r.page ? r.page.next : 0; cell = r ? r.cell : ''; sess = r ? r.session : '';
          if (!(r && r.page && r.page.more && list.length)) dry = 9;
        });
      } else {
        req = (bq ? Promise.resolve(bq) : boards().then(function (bl) { bq = bl.map(function (b) { return b.id; }); return bq; })).then(function (ids) {
          if (bi >= ids.length) { more = false; return; }
          return api('/api/rank', { query: { board: ids[bi], offset: boff, session: bsess } }).then(function (r) {
            var list = (r && r.items) || [];
            remember(list);
            list.forEach(function (s) { if (s && s.id && !seen[s.id]) { seen[s.id] = 1; items.push(s); } });
            if (r && r.more && list.length) { boff = r.next; bsess = r.session; } else { bi++; boff = 0; bsess = ''; }
          });
        });
      }
      pending = req.then(function () {
        dry = items.length > before ? 0 : dry + 1;
        if (src === 'fy' && dry >= 2) { src = 'board'; dry = 0; }
        else if (src === 'board' && dry >= 3) { bi++; boff = 0; bsess = ''; dry = 0; }
      }).catch(function () {
        if (src === 'fy') { src = 'board'; dry = 0; } else more = false;
      }).then(function () { pending = null; });
      return pending;
    }
    var feedCtrl = {
      items: items, index: 0,
      hasMore: function () { return more; },
      itemAt: async function (idx) {
        if (idx < 0) return null;
        while (idx >= items.length && more && !aborted) await fetchMore();
        if (aborted) return null;
        return items[idx] || null;
      },
      prefetchAhead: function (idx) {
        if (idx + 4 >= items.length && more && !aborted) fetchMore().catch(function () {});
        [idx + 1, idx + 2].forEach(function (k) {
          var s = items[k];
          if (s && s.id) {
            if (s.cover) new Image().src = LV.sized(s.cover, 720);
            api('/api/detail', { query: { id: s.id, lite: '1' }, ttl: TTL }).catch(function () {});
          }
        });
      }
    };
    cleanups.push(function () {
      aborted = true;
      if (PL && PL.feed === feedCtrl && PL.close) PL.close(true);
      else if (!PL && !OPENING) { el.hidden = true; el.innerHTML = ''; el.className = ''; }
    });
    function promoteFresh() {
      if (promoted || aborted || !seedCount || feedCtrl.index > bootIndex) return;
      var fresh = items.slice(seedCount);
      if (!fresh.length) return;
      promoted = true;
      items.length = seedCount;
      items.splice.apply(items, [bootIndex + 1, 0].concat(fresh));
      feedCtrl.prefetchAhead(feedCtrl.index);
    }
    async function boot() {
      try {
        if (seedCount) fetchMore().then(promoteFresh, function () {});
        while (!items.length && more && !aborted) await fetchMore();
        if (aborted) return;
        var lastErr = null;
        for (var k = 0; k < items.length && k < 5; k++) {
          var s = items[k], r;
          feedCtrl.prefetchAhead(k);
          if (s.firstVid) playInfo(s.firstVid, LV.get('quality')).catch(function () {});
          try { r = await api('/api/detail', { query: { id: s.id, lite: '1' }, ttl: TTL }); } catch (er) { lastErr = er; continue; }
          if (aborted) return;
          if (r && r.detail && r.detail.episodes && r.detail.episodes.length) {
            r.detail.favorite = !!r.favorite;
            bootIndex = k;
            feedCtrl.index = k;
            lastFeedFirstId = s.id;
            promoteFresh();
            var p = latestProgress(r.detail.id, r.progress);
            openPlayer(r.detail, p ? p.episodeIndex : 0, p ? p.positionMs : 0, true, feedCtrl);
            return;
          }
        }
        throw lastErr || new Error('暂时没有可刷的剧集');
      } catch (e) {
        if (aborted) return;
        $('.pload', el).classList.add('hide');
        el.innerHTML = '<div class="perr"><div class="box"><h3>加载失败</h3><p>' + esc(e && e.message || '请稍后重试') + '</p><button class="bplay" data-feed-retry>' + ic('refresh') + '重试</button></div></div>';
        $('[data-feed-retry]', el).onclick = function () { if (!aborted) feedPage(); };
      }
    }
    boot();
  }

  function openStandalonePlay() {
    if (PL) return;
    var qs = new URLSearchParams(location.search);
    var id = qs.get('id') || '', ep = +(qs.get('ep') || 0), pos = +(qs.get('pos') || 0);
    if (!id) { title('播放'); mount(empty('film', '播放参数无效', '', '')); return; }
    mount('');
    api('/api/detail', { query: { id: id, lite: '1' }, ttl: TTL }).then(function (r) {
      if (PL) return;
      if (!r || !r.detail || !r.detail.episodes || !r.detail.episodes.length) {
        mount(empty('film', '暂无可播放剧集', '', ''));
        return;
      }
      var idx;
      if (qs.has('ep')) {
        idx = Math.max(0, Math.min(ep, r.detail.episodes.length - 1));
      } else {
        var lp = latestProgress(id, r.progress);
        idx = lp ? Math.max(0, Math.min(lp.episodeIndex, r.detail.episodes.length - 1)) : 0;
        if (lp && !qs.has('pos')) pos = lp.positionMs || 0;
      }
      openWebPlayer(r.detail, idx, pos, true);
    }).catch(function (er) {
      mount(failed(er && er.message));
    });
  }
  function openPlayer(d, index, posMs, reuseHistory, feed) {
    if (PL) return; closeMenu();
    if (!feed && LV.caps.desktop && LV.caps.nativePlayer && LV.get('nativePlayer')) {
      var epIdx = Math.max(0, Math.min(index, d.episodes.length - 1));
      var nep = d.episodes[epIdx];
      playInfo(nep.vid, LV.get('quality')).then(function (r) {
        return api('/api/native/play', { body: { url: location.origin + r.src, title: (d.title || '') + ' - 第 ' + nep.index + ' 集', startSec: (posMs || 0) / 1000, gpuAccel: !!LV.get('gpuAccel'), superRes: LV.get('superRes') || 'off', frameInterp: LV.get('frameInterp') || 'off' } });
      }).then(function (res) {
        if (res && res.ok) {
          hideInlinePlayerOverlay();
          LV.toast('已在独立播放器中打开');
        } else {
          openWebPlayer(d, index, posMs, reuseHistory, feed);
        }
      }).catch(function () {
        openWebPlayer(d, index, posMs, reuseHistory, feed);
      });
      return;
    }
    if (!feed && !isStandalonePlay()) {
      var epIdx2 = Math.max(0, Math.min(index, d.episodes.length - 1));
      var playUrl = fullPath('/play?id=' + encodeURIComponent(d.id) + '&ep=' + epIdx2 + '&pos=' + Math.max(0, Math.round(posMs || 0)));
      if (launchStandalonePlayer(playUrl)) return;
    }
    openWebPlayer(d, index, posMs, reuseHistory, feed);
  }
  function openWebPlayer(d, index, posMs, reuseHistory, feed) {
    if (PL) return; closeMenu();
    var el = $('#player'); el.hidden = false; el.className = feed ? 'feed' : '';
    var TOUCH = matchMedia('(hover: none)').matches, dockOn = false;
    var standaloneTitlebar = isStandalonePlay() && LV.caps.customTitlebar;
    el.innerHTML = '<div class="amb"><i style="background-image:url(\'' + esc(LV.sized(d.cover, 200)) + '\')"></i><b></b></div>' +
      '<div class="stage">' + (feed ? '<div class="fd-cover"></div>' : '') + '</div><div class="dml"></div><div class="flash"></div><div class="pload"><i></i><span>正在加载</span></div><div class="ab-pill" hidden></div>' +
      (standaloneTitlebar ? '<div class="win-ctrls win-ctrls-player"><button class="win-btn" type="button" data-win="minimize" title="最小化" aria-label="最小化"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button><button class="win-btn" type="button" data-win="maximize" title="最大化 / 还原" aria-label="最大化"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg></button><button class="win-btn win-close" type="button" data-win="close" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' : '') +
      '<div class="ui"><div class="shade t"></div><div class="shade b"></div>' +
      '<div class="ptop">' + ((standaloneTitlebar || feed) ? '' : '<button class="cbtn" data-a="close" title="返回 (Esc)" aria-label="返回">' + ic('back') + '</button>') + '<div class="title"><b class="tt"></b><small class="ee"></small></div>' +
      (feed ? '<span class="fd-hint">上下滑动 / ↑ ↓ 切换剧集</span>' : '') + '</div>' +
      (feed ? '<div class="fd-nav"><button class="cbtn fd-up" data-a="fprev" title="上一部 (↑ / 滚轮上)" aria-label="上一部">' + ic('back') + '</button><button class="cbtn fd-dn" data-a="fnext" title="下一部 (↓ / 滚轮下)" aria-label="下一部">' + ic('back') + '</button></div>' : '') +
      '<div class="mid"><button class="big" data-a="toggle" title="播放 (空格)" aria-label="播放">' + ic('play', 'play') + '</button></div>' +
      '<div class="pbot">' + (feed ? '<div class="fd-info"><h2></h2><div class="fd-sub"></div><p class="fd-desc"></p></div>' : '') +
      '<div class="prog"><div class="r2"><div class="buf"></div><div class="fill"></div><div class="knob"></div></div><div class="tip">0:00</div></div>' +
      '<div class="ctrl"><button class="cbtn plain pp" data-a="toggle" title="播放 / 暂停 (空格)" aria-label="播放 / 暂停">' + ic('pause') + '</button><button class="cbtn plain" data-a="prev" title="上一集 (P)" aria-label="上一集">' + ic('prev') + '</button><button class="cbtn plain" data-a="next" title="下一集 (N)" aria-label="下一集">' + ic('next') + '</button><span class="time">0:00 / 0:00</span><span class="sp"></span>' +
      (feed ? '<button class="cbtn plain" data-a="fav" title="追剧" aria-label="追剧">' + ic('heart') + '</button>' : '') +
      (LV.caps.download ? '<button class="cbtn plain" data-a="dl" title="下载剧集" aria-label="下载剧集">' + ic('download') + '</button>' : '') +
      '<button class="cbtn plain" data-a="dm" title="弹幕开关 (D)" aria-label="弹幕开关">' + ic('danmaku') + '</button><button class="cbtn plain" data-a="dmset" title="弹幕设置" aria-label="弹幕设置">' + ic('sliders') + '</button><button class="cbtn plain" data-a="vol" title="音量 (M 静音)" aria-label="音量">' + ic('volume') + '</button>' +
      '<button class="cbtn plain" data-a="rate" title="倍速 (1x)" aria-label="倍速">' + ic('speed') + '</button><button class="cbtn plain" data-a="quality" title="清晰度" aria-label="清晰度">' + ic('hd') + '</button>' +
      (LV.caps.desktop && LV.caps.gpuShaders && LV.supportsGpuEnhancement() ? '<button class="cbtn plain" data-a="gpufx" title="画质增强" aria-label="画质增强">' + ic('enhance') + '</button>' : '') +
      '<button class="cbtn plain" data-a="tools" title="播放工具" aria-label="播放工具">' + ic('tools') + '</button>' +
      '<button class="cbtn plain" data-a="dock" title="选集与评论 (T)" aria-label="选集与评论">' + ic('list') + '</button><button class="cbtn plain" data-a="full" title="全屏 (F)" aria-label="全屏">' + ic('full') + '</button></div></div></div>' +
      (feed ? '<div class="fd-bar"><i></i></div>' : '') +
      '<div class="dock-backdrop"><aside class="dock" role="dialog" aria-modal="true" aria-label="选集与评论"><div class="dh"><div class="dseg"><i></i><button class="dtab on" data-dt="eps">选集</button><button class="dtab" data-dt="cm">评论</button></div><button class="cbtn plain" data-a="dock" title="关闭 (Esc)" aria-label="关闭">' + ic('close') + '</button></div><div class="db"></div></aside></div>';
    el.classList.toggle('dock-on', dockOn);
    var stage = $('.stage', el), v = null, dm = new LV.Danmaku($('.dml', el)), db = $('.db', el);
    var gpuFx = (LV.caps.desktop && LV.caps.gpuShaders && LV.supportsGpuEnhancement() && LV.GpuVideoFX) ? new LV.GpuVideoFX(stage) : null;
    var fdCover = $('.fd-cover', stage), fdBar = $('.fd-bar i', el);
    var S = { d: d, i: Math.max(0, Math.min(index, d.episodes.length - 1)), gears: [], quality: LV.get('quality'), activeQuality: LV.get('quality'), def: '', start: posMs / 1000, idle: 0, token: 0, tab: 'eps', cmN: 30, pre: null, browseDetail: d, browseSeasonID: d.id, seasonDetails: {}, seasonRequest: 0, browseLoading: false, recovery: { attempts: 0, timer: null, stable: null, stall: null },
      feed: feed || null, feedIdx: feed ? feed.index : 0, feedWarms: Object.create(null), feedNavToken: 0, fav: !!d.favorite, slideTimer: null,
      outroSkipped: false, srcAr: null,
      feedHistoryEligible: !feed || index >= 1 || !!progressOf(d.id) };
    S.seasonDetails[d.id] = d;
    PL = S;
    function syncRateUI() {
      var r = +LV.get('rate') || 1, rb = $('[data-a=rate]', el);
      if (rb) {
        rb.classList.toggle('on', r !== 1);
        rb.title = '倍速 · ' + r + 'x';
        rb.setAttribute('aria-label', '倍速 ' + r + 'x');
      }
    }
    syncRateUI();
    dm.config({ on: LV.get('danmaku'), op: LV.get('dmOpacity'), speed: LV.get('dmSpeed'), size: LV.get('dmSize'), area: LV.get('dmArea') });
    $('[data-a=dm]', el).classList.toggle('on', LV.get('danmaku'));
    if (!reuseHistory && !feed) window.history.pushState({ p: 1 }, '');
    var prog = $('.prog', el), fill = $('.fill', el), buf = $('.buf', el), knob = $('.knob', el), tip = $('.tip', el), timeEl = $('.time', el);
    function setIcon(b, n) { b.innerHTML = ic(n, n === 'play' ? 'play' : ''); }
    function ppIcon(n) { var b = $('.ctrl [data-a=toggle]', el); if (b) setIcon(b, n); var mb = $('.mid .big', el); if (mb) setIcon(mb, n); }
    function volIcon() { setIcon($('[data-a=vol]', el), !v || v.muted || !v.volume ? 'mute' : 'volume'); }
    function flash(n) { var f = $('.flash', el); f.innerHTML = ic(n); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
    function showUI() {
      el.classList.remove('idle'); clearTimeout(S.idle);
      S.idle = setTimeout(function hideWhenIdle() {
        if (PL !== S || !v || v.paused) return;
        if ($('.prog.drag', el) || $('.pmenu', el) || $('.pbot:hover,.ptop:hover,.pmenu:hover,.fd-nav:hover,.win-ctrls-player:hover', el)) { S.idle = setTimeout(hideWhenIdle, 500); return; }
        closePm(); el.classList.add('idle');
      }, 2800);
    }
    function closePm() { var m = $('.pmenu', el); if (m) m.remove(); }
    function syncVideoFx() {
      var aspect = LV.get('aspect') || 'fit', rot = (+LV.get('rotate') || 0) % 360;
      var tf = [];
      if (rot) tf.push('rotate(' + rot + 'deg)');
      var tfStr = tf.join(' '), fit = aspect === 'fill' ? 'cover' : 'contain';
      if (aspect === '16:9') S.ar = 16 / 9;
      else if (aspect === '4:3') S.ar = 4 / 3;
      else if (aspect === '9:16') S.ar = 9 / 16;
      else if (S.srcAr) S.ar = S.srcAr;
      if (S.ar) { el.style.setProperty('--ar', S.ar); el.classList.remove('noar'); }
      $$('video', stage).forEach(function (vidEl) { vidEl.style.transform = tfStr; vidEl.style.objectFit = fit; });
      if (v) v.loop = !!LV.get('loopOne');
      if (gpuFx) {
        gpuFx.configure({
          superRes: LV.get('superRes') || 'off',
          frameInterp: LV.get('frameInterp') || 'off',
          splitCompare: !!LV.get('splitCompare'),
          brightness: +LV.get('vBright') || 1,
          contrast: +LV.get('vContrast') || 1,
          saturation: +LV.get('vSat') || 1
        });
        var gb = $('[data-a=gpufx]', el);
        if (gb) gb.classList.toggle('on', gpuFx.isActive());
      }
      var tb = $('[data-a=tools]', el);
      if (tb) tb.classList.toggle('on', aspect !== 'fit' || rot !== 0 || !!LV.get('loopOne'));
    }
    function takeScreenshot() {
      if (!v || !v.videoWidth) return LV.toast('视频尚未就绪');
      var dataUrl = gpuFx ? gpuFx.captureFrame() : (function () {
        var c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        var ctx = c.getContext('2d'); if (!ctx) return null; ctx.drawImage(v, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
      })();
      if (!dataUrl) return LV.toast('截图失败');
      var ep = d.episodes[S.i], a = document.createElement('a');
      a.href = dataUrl; a.download = (d.title || 'lvguo') + '-第' + ep.index + '集-' + Math.floor(v.currentTime || 0) + 's.png';
      document.body.appendChild(a); a.click(); a.remove();
      LV.toast('已保存高清截图');
    }
    function togglePiP() {
      if (!v) return;
      if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function () {}); }
      else if (v.requestPictureInPicture) { v.requestPictureInPicture().catch(function () { LV.toast('当前环境不支持画中画'); }); }
      else LV.toast('当前环境不支持画中画');
    }

    // ---------- 视频元素：两路轮换，下一集在后台缓冲好，切集直接换上
    // 倍速必须同时写 defaultPlaybackRate：浏览器给 <video> 指定 src 时会执行加载算法，
    // 把 playbackRate 复位成 defaultPlaybackRate，只写 playbackRate 会被静默拉回 1x。
    function applyRate(x) {
      var r = +LV.get('rate') || 1;
      if (x) { x.defaultPlaybackRate = r; x.playbackRate = r; }
      return r;
    }
    function mkVideo(poster) {
      var x = document.createElement('video'); x.playsInline = true; x.preload = 'auto'; x.className = 'vid';
      if (poster) x.poster = poster;
      x.volume = LV.get('volume'); x.muted = LV.get('muted'); applyRate(x);
      ['loadedmetadata', 'playing', 'waiting', 'pause', 'play', 'seeked', 'canplay', 'error', 'ended'].forEach(function (ev) { x.addEventListener(ev, function (e) { if (PL === S && x === v) on[ev](e); }); });
      return x;
    }
    function disposeVideo(x) {
      if (!x) return;
      if (x._warm) x._warm.cancelled = true;
      x.pause(); x.removeAttribute('src'); x.load(); x.remove();
    }
    function prepare(i) {
      if (PL !== S || i < 0 || i >= d.episodes.length) return;
      if (S.pre && S.pre.i === i && S.pre.q === S.quality) return S.pre.promise;
      dropPre();
      var ep = d.episodes[i], x = mkVideo(ep.cover ? LV.sized(ep.cover, 720) : '');
      var tk = { i: i, q: S.quality, v: x, cancelled: false };
      x._warm = tk; x.muted = true; x.classList.add('pre'); stage.appendChild(x); S.pre = tk;
      tk.promise = playInfo(ep.vid, S.quality).then(function (r) {
        if (tk.cancelled || PL !== S) throw new Error('preload cancelled');
        tk.r = r; x.src = r.src; x.load(); return r;
      }).catch(function (e) {
        if (S.pre === tk) { S.pre = null; disposeVideo(x); }
        throw e;
      });
      tk.promise.catch(function () {});
      return tk.promise;
    }
    function dropPre() { var tk = S.pre; S.pre = null; if (tk) disposeVideo(tk.v); }
    function dropNextSeason() {
      var warm=S.nextSeasonWarm;S.nextSeasonWarm=null;
      if(warm){warm.cancelled=true;if(warm.v)disposeVideo(warm.v)}
    }
    function disposeFeedWarm(w) {
      if (!w) return;
      w.cancelled = true;
      if (w.v && w.v !== v && w.v !== S.visible && w.v !== S.retiring) disposeVideo(w.v);
    }
    function dropFeedWarms(keepIds) {
      Object.keys(S.feedWarms).forEach(function (id) {
        if (keepIds && keepIds[id]) return;
        disposeFeedWarm(S.feedWarms[id]);
        delete S.feedWarms[id];
      });
    }
    function trimFeedWarms(centerIdx) {
      var keys = Object.keys(S.feedWarms);
      if (keys.length <= 5) return;
      var keep = {};
      [centerIdx - 1, centerIdx, centerIdx + 1, centerIdx + 2, centerIdx + 3].forEach(function (k) {
        var it = feed && feed.items[k];
        if (it) keep[it.id] = 1;
      });
      keys.forEach(function (id) {
        if (!keep[id] && Object.keys(S.feedWarms).length > 5) {
          disposeFeedWarm(S.feedWarms[id]);
          delete S.feedWarms[id];
        }
      });
    }
    function cssUrl(u) { return u ? "url('" + String(u).replace(/['\\\n\r]/g, '') + "')" : ''; }
    function feedCanRecordHistory() {
      if (!feed) return true;
      // 刷剧模式：只看第 1 集（未进第 2 集）绝不入历史记录，避免刷剧把历史记录弄乱；已有历史或进入第 2 集才记录。
      if (S.feedHistoryEligible) return true;
      if (S.i >= 1 || !!progressOf(d.id)) { S.feedHistoryEligible = true; return true; }
      return false;
    }
    function persistSeriesProgress() {
      if (!(S.reportStarted && feedCanRecordHistory() && v && d.episodes[S.i])) return null;
      var saved = Object.assign({}, progressOf(d.id) || {}, { seriesId: d.id, title: d.title, cover: d.cover,
        vid: d.episodes[S.i].vid, episodeIndex: S.i, positionMs: Math.max(0, Math.round((v.currentTime || 0) * 1000)),
        episodeCount: d.episodes.length, time: Date.now() });
      recentPlayback.set(d.id, saved);
      hist = [saved].concat(hist.filter(function (x) { return x.seriesId !== d.id; }));
      saveCachedHist();
      window.dispatchEvent(new CustomEvent('lv:progress', { detail: saved }));
      return saved;
    }
    function syncFeedUI() {
      if (!feed) return;
      var ep = d.episodes[S.i];
      var h2 = $('.fd-info h2', el), sub = $('.fd-info .fd-sub', el), desc = $('.fd-info .fd-desc', el);
      if (h2) h2.textContent = d.title || '';
      if (sub) {
        var parts = ['第 ' + ep.index + ' 集 · 共 ' + d.episodes.length + ' 集'];
        if (d.tag) parts.push(d.tag);
        if (d.plays) parts.push(playsShort(d.plays) + ' 次播放');
        sub.textContent = parts.join(' · ');
      }
      if (desc) desc.textContent = d.intro || '';
      var fb = $('[data-a=fav]', el);
      if (fb) {
        fb.classList.toggle('on', !!S.fav);
        fb.innerHTML = ic(S.fav ? 'heartfill' : 'heart');
        fb.setAttribute('aria-label', S.fav ? '已追剧' : '追剧');
        fb.title = S.fav ? '已追剧' : '追剧';
      }
      var up = $('.fd-up', el), dn = $('.fd-dn', el);
      if (up) up.disabled = S.feedIdx <= 0;
      if (dn) dn.disabled = S.feedIdx >= feed.items.length - 1 && !feed.hasMore();
    }
    function warmFeedDrama(targetIdx) {
      if (!feed || PL !== S || targetIdx < 0) return;
      var q = S.quality, tk = S.token;
      feed.itemAt(targetIdx).then(function (item) {
        if (PL !== S || !item || !item.id) return;
        if (item.cover) new Image().src = LV.sized(item.cover, 720);
        feed.prefetchAhead(targetIdx);
        var existing = S.feedWarms[item.id];
        if (existing && existing.q === q && !existing.cancelled) return existing.promise;
        if (existing) disposeFeedWarm(existing);
        var warm = { id: item.id, q: q, cancelled: false, v: null, detail: null, favorite: !!item.favorite, r: null, i: 0, startSec: 0 };
        S.feedWarms[item.id] = warm;
        trimFeedWarms(S.feedIdx);
        function alive() { return PL === S && !warm.cancelled && S.feedWarms[item.id] === warm; }
        warm.promise = api('/api/detail', { query: { id: item.id, lite: '1' }, ttl: TTL }).then(function (r) {
          if (!alive()) throw new Error('preload cancelled');
          if (!r || !r.detail || !r.detail.episodes || !r.detail.episodes.length) throw new Error('no episodes');
          warm.detail = r.detail; warm.favorite = !!r.favorite; warm.detail.favorite = warm.favorite;
          var p = latestProgress(item.id, r.progress);
          var epIdx = p ? Math.max(0, Math.min(p.episodeIndex || 0, r.detail.episodes.length - 1)) : 0;
          warm.i = epIdx; warm.startSec = p ? (p.positionMs || 0) / 1000 : 0;
          var ep = r.detail.episodes[epIdx], x = mkVideo('');
          x.muted = true; x.classList.add('pre'); stage.appendChild(x);
          warm.v = x; x._warm = warm;
          if (warm.startSec > 0) {
            x.addEventListener('loadedmetadata', function () {
              if (!warm.cancelled && Number.isFinite(x.duration) && x.duration > 0) {
                x.currentTime = Math.min(warm.startSec, Math.max(0, x.duration - 0.25));
              }
            }, { once: true });
          }
          return playInfo(ep.vid, q).then(function (info) {
            if (!alive()) throw new Error('preload cancelled');
            warm.r = info; x.src = info.src; x.load();
            return info;
          });
        }).catch(function (e) {
          if (S.feedWarms[item.id] === warm) { delete S.feedWarms[item.id]; disposeFeedWarm(warm); }
          throw e;
        });
        warm.promise.catch(function () {});
        return warm.promise;
      }).catch(function () {});
    }
    async function feedSwitch(targetIdx, dir, skipped) {
      if (!feed || PL !== S) return;
      if (targetIdx < 0) return LV.toast('已经是第一部');
      skipped = skipped || 0;
      var navToken = ++S.feedNavToken;
      var item = await feed.itemAt(targetIdx);
      if (PL !== S || navToken !== S.feedNavToken) return;
      if (!item || !item.id) return LV.toast('暂时没有更多新剧');
      persistSeriesProgress();
      var warm = S.feedWarms[item.id];
      if (warm && warm.q === S.quality && !warm.cancelled) delete S.feedWarms[item.id];
      else warm = null;
      var detail = warm && warm.detail, fav = warm ? warm.favorite : !!item.favorite, epIdx = warm ? warm.i : 0, startSec = warm ? warm.startSec : 0;
      if (!detail) {
        try {
          var r = warm ? await warm.promise.then(function () { return null; }).catch(function () { return null; }) : null;
          if (PL !== S || navToken !== S.feedNavToken) { if (warm) disposeFeedWarm(warm); return; }
          if (warm && warm.detail) {
            detail = warm.detail; fav = warm.favorite; epIdx = warm.i; startSec = warm.startSec;
          } else {
            r = await api('/api/detail', { query: { id: item.id, lite: '1' }, ttl: TTL });
            if (PL !== S || navToken !== S.feedNavToken) { if (warm) disposeFeedWarm(warm); return; }
            if (!r || !r.detail || !r.detail.episodes || !r.detail.episodes.length) throw new Error('暂无可播放剧集');
            detail = r.detail; fav = !!r.favorite; detail.favorite = fav;
            var p = latestProgress(item.id, r.progress);
            epIdx = p ? Math.max(0, Math.min(p.episodeIndex || 0, detail.episodes.length - 1)) : 0;
            startSec = p ? (p.positionMs || 0) / 1000 : 0;
            warm = null;
          }
        } catch (e) {
          if (warm) disposeFeedWarm(warm);
          if (PL === S && navToken === S.feedNavToken) {
            var stepDir = dir < 0 ? -1 : 1;
            if (skipped < 4 && (targetIdx + stepDir >= 0)) {
              return feedSwitch(targetIdx + stepDir, stepDir, skipped + 1);
            }
            S.feedIdx = targetIdx; feed.index = targetIdx;
            LV.toast((e && e.message) || '加载失败，请重试');
          }
          return;
        }
      }
      dropPre(); dropNextSeason();
      d = detail; S.d = d; S.browseDetail = d; S.browseSeasonID = d.id;
      S.seasonDetails = {}; S.seasonDetails[d.id] = d; S.seasons = undefined; S.seasonsPending = null;
      S.gi = null; S.fav = fav; S.feedIdx = targetIdx; feed.index = targetIdx;
      S.feedHistoryEligible = epIdx >= 1 || !!progressOf(d.id);
      trimFeedWarms(targetIdx);
      return load(epIdx, startSec, dir, { slideDir: dir, feedWarm: warm });
    }
    function feedStep(dir) { return feedSwitch(S.feedIdx + dir, dir); }
    function seasonsFor(id) {
      if (Array.isArray(S.seasons) && S.seasons.some(function (x) { return x.id === id; })) return Promise.resolve(S.seasons);
      var hit = seasonsCache.get(id);
      if (hit && Date.now() - hit.at < 600e3) {
        S.seasons = hit.list;
        return Promise.resolve(hit.list);
      }
      if (S.seasonsPending && S.seasonsPending.id === id) return S.seasonsPending.promise;
      var pending = { id: id }; S.seasonsPending = pending;
      pending.promise = api('/api/seasons', { query: { id: id, quick: '1' }, ttl: TTL }).then(function (r) {
        var list = (r && r.seasons) || [];
        var entry = { at: Date.now(), list: list };
        seasonsCache.set(id, entry);
        list.forEach(function (x) { if (x && x.id) seasonsCache.set(x.id, entry); });
        if (PL === S) { S.seasons = list; if (S.tab === 'eps' && el.classList.contains('dock-on')) drawDock(); }
        return list;
      }).finally(function () { if (S.seasonsPending === pending) S.seasonsPending = null; });
      return pending.promise;
    }
    function warmNextSeason() {
      var origin=d.id,q=S.quality;
      if(S.nextSeasonWarm&&S.nextSeasonWarm.origin===origin&&S.nextSeasonWarm.q===q)return S.nextSeasonWarm.promise;
      dropNextSeason();var warm={origin:origin,q:q,cancelled:false,v:null};S.nextSeasonWarm=warm;
      function alive(){return PL===S&&!warm.cancelled&&d.id===origin}
      warm.promise=seasonsFor(origin).then(function(list){
        if(!alive())throw new Error('preload cancelled');
        var current=list.find(function(x){return x.id===origin})||list.find(function(x){return x.current});
        if(!current)return null;
        var next=list.filter(function(x){return x.number>current.number}).sort(function(a,b){return a.number-b.number})[0];
        if(!next)return null;warm.next=next;if(!(next.episodes>0))return warm;
        var cached=S.seasonDetails[next.id];
        return (cached?Promise.resolve({detail:cached}):api('/api/detail',{query:{id:next.id,lite:'1'},ttl:TTL})).then(function(r){
          if(!alive())throw new Error('preload cancelled');
          if(!r.detail||!r.detail.episodes||!r.detail.episodes.length)return warm;
          warm.detail=r.detail;S.seasonDetails[next.id]=r.detail;
          var ep=r.detail.episodes[0],x=mkVideo(ep.cover?LV.sized(ep.cover,720):'');warm.v=x;warm.i=0;x._warm=warm;x.muted=true;x.classList.add('pre');stage.appendChild(x);
          return playInfo(ep.vid,q).then(function(info){if(!alive())throw new Error('preload cancelled');warm.r=info;x.src=info.src;x.load();return warm});
        });
      }).catch(function(e){if(S.nextSeasonWarm===warm)dropNextSeason();throw e});
      warm.promise.catch(function(){});return warm.promise;
    }
    function presentVideo(x, token) {
      if (PL !== S || S.token !== token || x !== v) return;
      clearTimeout(S.loadingTimer);
      if (fdCover) fdCover.classList.remove('show');
      var old = S.visible, sliding = !!(S.slideTimer && S.retiring === old);
      S.visible = x; x.classList.remove('pre', 'pending'); x.style.zIndex = '';
      el.classList.add('ready'); $('.pload', el).classList.add('hide');
      var error = $('.perr', el); if (error) error.remove();
      if (old && old !== x && !sliding) {
        if (S.retiring && S.retiring !== old) disposeVideo(S.retiring);
        S.retiring = old;
        x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        setTimeout(function () { if (S.visible !== old) disposeVideo(old); if (S.retiring === old) S.retiring = null; }, 140);
      }
    }
    function presentFirstFrame() {
      if (S.frameCancel) S.frameCancel();
      var x = v, token = S.token;
      if (x.requestVideoFrameCallback) {
        // A fully transparent video may never be composited, so some browsers
        // never fire the frame callback even though decoding and audio continue.
        var fallback = setTimeout(function () {
          if (PL === S && S.token === token && x === v && x.readyState >= 2 && !x.paused) {
            if (x.cancelVideoFrameCallback) x.cancelVideoFrameCallback(id);
            S.frameCancel = null; presentVideo(x, token);
          }
        }, 700);
        var id = x.requestVideoFrameCallback(function () { clearTimeout(fallback); S.frameCancel = null; presentVideo(x, token); });
        S.frameCancel = function () { clearTimeout(fallback); if (x.cancelVideoFrameCallback) x.cancelVideoFrameCallback(id); };
      } else {
        var id2 = requestAnimationFrame(function () { S.frameCancel = null; if (x.readyState >= 2) presentVideo(x, token); });
        S.frameCancel = function () { cancelAnimationFrame(id2); };
      }
    }
    function applyInfo(r) {
      S.gears = r.gears || []; S.def = r.definition;
      S.activeQuality = r.definition || S.activeQuality;
      var gg = S.gears.find(function (g) { return g.definition === r.definition; }) || S.gears[0];
      if (gg && gg.width && gg.height) { S.srcAr = gg.width / gg.height; syncVideoFx(); }
      var qb = $('[data-a=quality]', el);
      if (qb) {
        var qlbl = '清晰度 · ' + (r.definition || '自动');
        qb.title = qlbl;
        qb.setAttribute('aria-label', qlbl);
      }
    }

    function drawDock() {
      $$('.dtab', el).forEach(function (t) { t.classList.toggle('on', t.dataset.dt === S.tab); });
      var on2 = $('.dtab.on', el), ind = $('.dseg i', el); if (on2 && ind) { ind.style.width = on2.offsetWidth + 'px'; ind.style.transform = 'translateX(' + on2.offsetLeft + 'px)'; }
      if (S.tab === 'eps') {
        var listDetail = S.browseDetail || d, sameSeason = listDetail.id === d.id;
        var total = listDetail.episodes.length, groups = total ? (total > 110 ? LV.group(total, 100) : [[1, total]]) : [];
        var gi = S.gi == null ? Math.floor((sameSeason ? S.i : 0) / 100) : S.gi;
        if (gi >= groups.length) gi = 0; S.gi = gi;
        // 季标签只切换选集面板的数据；当前播放剧集与自动续播仍由 d 保持。
        if (S.seasons === undefined) {
          var hitSeas = seasonsCache.get(d.id);
          if (hitSeas && Date.now() - hitSeas.at < 600e3) S.seasons = hitSeas.list;
          else if (d.multiSeason) { S.seasons = null; seasonsFor(d.id).catch(function () { if (PL === S) { S.seasons = []; drawDock(); } }); }
          else S.seasons = [];
        }
        var seasLoading = d.multiSeason && S.seasons === null;
        var seas = S.seasons && S.seasons.length > 1 ? S.seasons : null;
        var seasBar = seas
          ? '<div class="epseas">' + seas.map(function (x) { var cur = x.id === S.browseSeasonID, soon = !x.episodes; return '<button class="' + (cur ? 'on' : '') + (soon ? ' soon' : '') + '" data-season="' + x.id + '"' + (cur ? ' disabled' : '') + '>第 ' + x.number + ' 季' + (soon ? '<em>待上线</em>' : '') + '</button>'; }).join('') + '</div>'
          : (seasLoading ? '<div class="epseas sk"><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>' : '');
        var browseSeason = (S.seasons || []).filter(function (x) { return x.id === S.browseSeasonID; })[0];
        var currentEpisode = d.episodes[S.i], currentSeason = (S.seasons || []).filter(function (x) { return x.id === d.id; })[0];
        var metaParts = [];
        if (browseSeason) metaParts.push('第 ' + browseSeason.number + ' 季');
        if (total) metaParts.push('全 ' + total + ' 集');
        if (listDetail.plays) metaParts.push(playsShort(listDetail.plays) + '播放');
        if (listDetail.tag) metaParts.push(listDetail.tag);
        var detailCard = S.browseLoading
          ? '<div class="epdetail sk"><div class="epd-cov skel"></div><div class="epd-body"><div class="skel t m"></div><div class="skel t s"></div><div class="skel t l"></div></div></div>'
          : '<div class="epdetail"><div class="epd-cov poster">' + (listDetail.cover ? LV.img(listDetail.cover, listDetail.title, 200) : '') + '</div>' +
            '<div class="epd-body"><div class="epd-title">' + esc(listDetail.title || '') + '</div>' +
            (metaParts.length ? '<div class="epd-meta">' + esc(metaParts.join(' · ')) + '</div>' : '') +
            (listDetail.intro ? '<div class="epd-intro">' + esc(listDetail.intro) + '</div>' : '') + '</div></div>';
        var status = !sameSeason && currentEpisode ? '<div class="epstatus">当前仍在播放：' + (currentSeason ? '第 ' + currentSeason.number + ' 季 · ' : '') + '第 ' + currentEpisode.index + ' 集</div>' : '';
        var episodeList = S.browseLoading ? epSk(12) : total && groups.length
          ? listDetail.episodes.slice(groups[gi][0] - 1, groups[gi][1]).map(function (e, k) { var i = groups[gi][0] - 1 + k; return epNum(e, i, sameSeason && i === S.i, sameSeason && i < S.i, sameSeason); }).join('')
          : '<div class="epempty">这一季暂时没有可播放的剧集</div>';
        db.innerHTML = '<div class="eptop">' + detailCard + seasBar +
          status + (groups.length > 1 ? '<div class="rngs">' + groups.map(function (g, k) { var playing = sameSeason && S.i >= g[0] - 1 && S.i <= g[1] - 1; return '<button class="' + (k === gi ? 'on' : '') + (playing ? ' has' : '') + '" data-gi="' + k + '">' + g[0] + '–' + g[1] + '</button>'; }).join('') + '</div>' : '') + '</div>' +
          '<div class="deps' + (S.browseLoading ? ' loading' : '') + '">' + episodeList + '</div>';
        var c = $('.epn.cur', db), top = $('.eptop', db); if (c) db.scrollTop = Math.max(0, c.offsetTop - (top ? top.offsetHeight : 0) - (db.clientHeight - (top ? top.offsetHeight : 0)) / 2 + c.offsetHeight / 2);
        var rg = $('.rngs .on', db); if (rg) rg.scrollIntoView({ block: 'nearest', inline: 'center' });
        var sr = $('.epseas', db), so = $('.epseas .on', db); if (sr && so) sr.scrollLeft = so.offsetLeft - (sr.clientWidth - so.offsetWidth) / 2;   // 当前季滚到中间
      } else {
        var list = dm.raw || [];
        if (!list.length) { db.innerHTML = '<div class="cmempty">' + (S.cmLoading ? '正在加载评论…' : '这一集还没有评论') + '</div>'; return; }
        db.innerHTML = '<div class="cms">' + list.slice(0, S.cmN).map(function (c) { return '<div class="cm"><div class="ca">' + (c.avatar ? LV.img(c.avatar, '', 100) : '') + esc((c.user || '用')[0]) + '</div><div class="cb"><div class="cn">' + esc(c.user || '匿名用户') + '</div><div class="cx">' + LV.emojiHTML(c.text) + '</div></div></div>'; }).join('') + '</div>' +
          (list.length > S.cmN ? '<button class="cmmore" data-cmmore>加载更多</button>' : '');
      }
    }
    $('.dock', el).addEventListener('click', function (e) {
      var t = e.target.closest('[data-dt]'), g = e.target.closest('[data-gi]'), b = e.target.closest('[data-ep]'), m = e.target.closest('[data-cmmore]'), se = e.target.closest('[data-season]');
      if (se && !se.disabled) return switchSeason(se.dataset.season);
      if (t) { S.tab = t.dataset.dt; if (S.tab === 'cm' && S.loadComments) S.loadComments(); drawDock(); } else if (g) { S.gi = +g.dataset.gi; drawDock(); } else if (b) selectEpisode(+b.dataset.ep); else if (m) { S.cmN += 30; drawDock(); }
    });

    // 切集先保留旧帧，等新视频实际呈现首帧后再交接；刷剧切剧则立刻执行纵向滑动转场。
    async function load(i, startSec, dir, options) {
      options = options || {};
      var slideDir = options.slideDir || 0, feedWarm = options.feedWarm || null;
      if (!options.recovery) {
        clearTimeout(S.recovery.timer); clearTimeout(S.recovery.stable); clearTimeout(S.recovery.stall);
        S.recovery = { attempts: 0, timer: null, stable: null, stall: null };
        S.activeQuality = S.quality;
      } else if (options.quality) S.activeQuality = options.quality;
      var ep = d.episodes[i];
      // 仅在真正切换集数/剧集时重置倍速，同集重试/切清晰度/自动恢复保留当前倍速
      if (S.loaded && S.gearVid !== ep.vid && !LV.get('keepRate')) { LV.set('rate', 1); syncRateUI(); }
      var first = !S.loaded; S.loaded = true;
      rep.stop(); S.report = null; S.reportStarted = false; var tk = ++S.token; S.i = i; S.gi = null; S.cmN = 30;
      // 选新集后不能用上一集的档位列表做恢复；/api/play 的 q 只选清晰度，
      // 上游取源失败时换 q 不会让同一集更容易取到源。
      if (S.gearVid !== ep.vid) { S.gearVid = ep.vid; S.gears = []; S.def = ''; S.outroSkipped = false; }
      $('.tt', el).textContent = d.title; $('.ee', el).textContent = '第 ' + ep.index + ' 集 · 共 ' + d.episodes.length + ' 集';
      document.title = (feed ? '刷剧 · ' : '') + '第 ' + ep.index + ' 集 · ' + d.title + ' - ' + brandName();
      syncFeedUI();
      if (fdCover) { fdCover.classList.remove('show'); fdCover.style.backgroundImage = cssUrl(LV.sized(ep.cover || d.cover, 720)); }
      var pe = $('.perr', el); if (pe) pe.remove(); var un = $('.upnext', el); if (un) un.remove(); clearTimeout(S.nextT);
      dm.clear(); dm.setPlaying(false); S.cmLoading = true; if (el.classList.contains('dock-on')) drawDock();
      clearTimeout(S.preT); clearTimeout(S.loadingTimer);
      if (S.slideTimer) { clearTimeout(S.slideTimer); S.slideTimer = null; }
      if (S.frameCancel) { S.frameCancel(); S.frameCancel = null; }
      var old = S.visible || null, nv, r, warm = null;
      if (S.retiring && S.retiring !== old) { disposeVideo(S.retiring); S.retiring = null; }
      if (v && v !== old) disposeVideo(v);
      if (feedWarm && feedWarm.v && !options.force) {
        warm = feedWarm; nv = warm.v; r = warm.r; nv._warm = null;
      } else if (S.pre && S.pre.i === i && S.pre.q === S.quality && !options.force) {
        warm = S.pre; S.pre = null; nv = warm.v; r = warm.r;
      } else {
        dropPre(); nv = mkVideo(feed ? '' : (ep.cover ? LV.sized(ep.cover, 720) : (first ? LV.sized(d.cover, 720) : '')));
        nv.classList.add('pre'); stage.appendChild(nv);
      }
      nv.classList.remove('pre');
      if (nv.readyState >= 2) nv.classList.remove('pending');
      else nv.classList.add('pending');
      v = nv; v.muted = LV.get('muted'); applyRate(v); volIcon();
      if (gpuFx) gpuFx.attach(nv);
      syncVideoFx();
      if (old && old !== nv) old.pause();
      if (slideDir && old && old !== nv) {
        if (old.getAnimations) old.getAnimations().forEach(function (a) { a.cancel(); });
        if (nv.getAnimations) nv.getAnimations().forEach(function (a) { a.cancel(); });
        old.style.transform = ''; old.style.zIndex = '0';
        nv.style.transform = ''; nv.style.zIndex = '1';
        S.retiring = old;
        if (nv.readyState >= 2) nv.classList.remove('pending');
        var ease = 'cubic-bezier(.22,1,.36,1)';
        old.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(' + (-slideDir * 100) + '%)' }], { duration: 260, easing: ease, fill: 'forwards' });
        nv.animate([{ transform: 'translateY(' + (slideDir * 100) + '%)' }, { transform: 'translateY(0)' }], { duration: 260, easing: ease, fill: 'forwards' });
        S.slideTimer = setTimeout(function () {
          S.slideTimer = null;
          if (S.visible !== old) disposeVideo(old);
          if (S.retiring === old) S.retiring = null;
          nv.style.zIndex = '';
        }, 280);
      }
      el.classList.remove('paused');
      $('.pload span', el).textContent = '正在加载';
      if (!old) el.classList.remove('ready');
      $('.pload', el).classList.add('hide');
      if (feed) { warmFeedDrama(S.feedIdx + 1); warmFeedDrama(S.feedIdx + 2); }
      S.loadingTimer = setTimeout(function () {
        if (PL === S && S.token === tk && S.visible !== nv && nv.readyState < 2) {
          if (slideDir && fdCover) fdCover.classList.add('show');
          $('.pload', el).classList.remove('hide');
        }
      }, slideDir ? 400 : 350);
      if (!S.ar) el.classList.add('noar');
      try {
        if (!r) { r = warm ? await warm.promise : await playInfo(ep.vid, S.activeQuality, !!options.force); if (PL !== S || tk !== S.token) return; if (!warm) nv.src = r.src; }
        applyInfo(r);
        S.start = startSec || 0;
        if (v.readyState >= 1 && S.start > 0 && Number.isFinite(v.duration) && v.duration > 0) {
          if (Math.abs((v.currentTime || 0) - S.start) > 1) v.currentTime = Math.min(S.start, Math.max(0, v.duration - 0.25));
          S.start = 0;
        }
        var p = v.play(); if (p && p.catch) p.catch(function (er) { if (tk !== S.token) return; if (er && er.name === 'NotAllowedError') { presentVideo(nv, tk); ppIcon('play'); $('.pload', el).classList.add('hide'); el.classList.add('ready', 'paused'); } else if (!er || er.name !== 'AbortError') autoRecover(tk); });
        // 真正开始播放后才上报进度/历史、拉取弹幕评论并预热下一集（见 on.playing），避免当前集首帧未出时其它请求抢占连接和带宽
        // 刷剧模式下仅短暂看第 1 集不入历史：直到进入第 2 集或单集观看达到阈值才开始上报。
        if (feed && i >= 1) S.feedHistoryEligible = true;
        var vv = v; S.report = function () {
          if (tk !== S.token || !feedCanRecordHistory()) return;
          S.report = null; S.reportStarted = true;
          rep.start(d.id, ep.vid, i, function () { return vv.currentTime; }, {title:d.title,cover:d.cover,episodeCount:d.episodes.length});
        };
        S.loadComments = function () { S.loadComments = null; dm.fetch(d.id, ep.vid, ep.duration).then(function () { S.cmLoading = false; if (tk === S.token) { dm.seek(v.currentTime || 0); if (S.tab === 'cm' && el.classList.contains('dock-on')) drawDock(); } }); };
        if (S.tab === 'cm' && el.classList.contains('dock-on')) S.loadComments();
      } catch (e) { if (tk === S.token) autoRecover(tk); }
    }
    function autoRecover(tk) {
      if (!PL || tk !== S.token || S.recovery.timer) return;
      var recovery = S.recovery, ep = d.episodes[S.i];
      clearTimeout(recovery.stall); recovery.stall = null;
      // navigator.onLine=false is a recoverable wait, not an exhausted source.
      // Keep the current episode open and resume automatically when the network returns.
      if (navigator.onLine === false) {
        $('.pload span', el).textContent = '正在缓冲'; $('.pload', el).classList.remove('hide');
        recovery.timer = setTimeout(function () {
          recovery.timer = null;
          if (PL === S && S.token === tk) autoRecover(tk);
        }, 5000);
        return;
      }
      recovery.attempts++;
      var current = (v && isFinite(v.currentTime) && v.currentTime > 0) ? v.currentTime : (S.start || 0);
      var gears = (S.gears || []).filter(function (g) { return g && g.definition && +g.short > 0 && !/bvc2|bytevc2/i.test(g.codec || ''); })
        .sort(function (a, b) { return +b.short - +a.short; });
      var currentGear = gears.find(function (g) { return g.definition === S.activeQuality; });
      var qualityIndex = currentGear ? gears.indexOf(currentGear) : -1;
      // If source discovery itself keeps failing there is no quality ladder yet. Keep
      // retrying with a longer backoff before treating the selected episode as terminal.
      if (recovery.budget == null) recovery.budget = qualityIndex >= 0 ? 2 * (gears.length - qualityIndex) : 12;
      if (recovery.attempts > recovery.budget) { fail('自动恢复多次后仍无法播放本集'); return; }
      recovery.qualityFailures = (recovery.qualityFailures || 0) + 1;
      if (recovery.qualityFailures >= 2) {
        if (qualityIndex >= 0 && qualityIndex < gears.length - 1) {
          S.activeQuality = gears[qualityIndex + 1].definition;
          recovery.qualityFailures = 0;
        } else if (qualityIndex >= 0 || recovery.attempts >= recovery.budget) {
          fail('自动恢复多次后仍无法播放本集'); return;
        }
      }
      $('.pload span', el).textContent = '正在缓冲'; $('.pload', el).classList.remove('hide');
      if (!S.visible) el.classList.remove('ready');
      var delay = Math.min(30000, 600 * Math.pow(2, Math.min(recovery.attempts - 1, 6)));
      var failedToken = tk;
      recovery.timer = setTimeout(function () {
        recovery.timer = null;
        if (!PL || S.token !== failedToken || S.i !== d.episodes.indexOf(ep)) return;
        load(S.i, current, 0, { recovery: true, quality: S.activeQuality, force: true });
      }, delay);
    }
    function fail(msg) {
      $('.pload', el).classList.add('hide'); var o = $('.perr', el); if (o) o.remove();
      var gear = (S.gears || []).find(function (g) { return g.definition === S.activeQuality; });
      var hevc = (v || document.createElement('video')).canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
      var codecHelp = gear && /hvc1|hev1|hevc/i.test(gear.codec || '') && !hevc;
      var explanation = codecHelp
        ? '当前浏览器不支持这一路 H.265（HEVC）视频解码。'
        : (msg || '已自动尝试恢复这一集，但暂时无法播放。');
      el.insertAdjacentHTML('beforeend', '<div class="perr"><div class="box"><button class="perr-close" data-a="close" aria-label="关闭播放器">' + ic('close') + '</button><h3>无法播放</h3><p>' + esc(explanation) + '</p><button class="bplay" data-a="retry">' + ic('refresh') + '重试</button></div></div>');
    }
    var on = {
      loadedmetadata: function () {
        // 部分浏览器在元数据就绪时会把 playbackRate 打回默认值，这里再兜一次底
        if ((+LV.get('rate') || 1) !== v.playbackRate) applyRate(v);
        if (v.videoWidth) { S.srcAr = v.videoWidth / v.videoHeight; syncVideoFx(); }
        if (S.start > 0 && Number.isFinite(v.duration) && v.duration > 0) v.currentTime = Math.min(S.start, Math.max(0, v.duration - 0.25));
        S.start = 0; dm.seek(v.currentTime);
      },
      playing: function () {
        clearTimeout(S.recovery.stall); clearTimeout(S.loadingTimer);
        watchDrops(S.token); if (S.report) S.report(); if (S.loadComments) S.loadComments(); presentFirstFrame();
        el.classList.remove('paused'); ppIcon('pause'); dm.setPlaying(true);
        clearTimeout(S.recovery.stable); var stableToken = S.token;
        S.recovery.stable = setTimeout(function () { if (PL === S && S.token === stableToken) { S.recovery.attempts = 0; S.recovery.qualityFailures = 0; } }, 6000);
        // Normal mode already triggers prepare(at + 1) inside load() after 120ms; idempotently ensure next/season preload here too.
        if (S.preFor !== stableToken) {
          S.preFor = stableToken; var at = S.i;
          if (feed) { warmFeedDrama(S.feedIdx + 1); warmFeedDrama(S.feedIdx + 2); }
          clearTimeout(S.preT);
          S.preT = setTimeout(function () {
            if (PL !== S || S.i !== at || S.token !== stableToken) return;
            var next = prepare(at + 1);
            if (!feed && at >= d.episodes.length - 2) warmNextSeason().catch(function () {});
            if (next && at + 2 < d.episodes.length) next.then(function () {
              if (PL === S && S.i === at && S.token === stableToken) prewarm(d.episodes[at + 2].vid, S.quality);
            }).catch(function () {});
          }, feed ? 1000 : 80);
        }
      },
      waiting: function () {
        if (v && v.paused) return; // 暂停中的缓冲不显示「正在加载」
        clearTimeout(S.loadingTimer);
        var loadingToken = S.token;
        S.loadingTimer = setTimeout(function () { if (PL === S && S.token === loadingToken && v && !v.paused && v.readyState < 3) $('.pload', el).classList.remove('hide'); }, 500);
        dm.setPlaying(false);
        if (S.recovery.stall) return;
        var waitingToken = S.token, waitingVideo = v, waitingAt = v && v.currentTime || 0;
        // Some browsers leave a dead stream in HAVE_CURRENT_DATA forever and never
        // dispatch "error". Detect a real stall and recover the same vid at its position.
        var recoveryState = S.recovery;
        recoveryState.stall = setTimeout(function () {
          recoveryState.stall = null;
          if (PL !== S || S.token !== waitingToken || v !== waitingVideo || !v || v.paused) return;
          if (v.readyState < 3 || Math.abs(v.currentTime - waitingAt) < 0.25) autoRecover(waitingToken);
        }, 18000);
      },
      pause: function () { clearTimeout(S.recovery.stall); $('.pload', el).classList.add('hide'); if (v.ended && LV.get('autonext') && (feed || S.i + 1 < d.episodes.length || (S.nextSeasonWarm && S.nextSeasonWarm.next && S.nextSeasonWarm.next.episodes > 0))) { dm.setPlaying(false); rep.flush(); return; } if (v.readyState >= 2) el.classList.add('paused'); ppIcon('play'); dm.setPlaying(false); showUI(); rep.flush(); },
      play: function () { el.classList.remove('paused'); ppIcon('pause'); if (!el.classList.contains('idle')) showUI(); },
      seeked: function () { dm.seek(v.currentTime); rep.flush(); if (v.paused) $('.pload', el).classList.add('hide'); },
      canplay: function () { if (v.paused) $('.pload', el).classList.add('hide'); },
      error: function () { if (v.getAttribute('src')) autoRecover(S.token); },
      ended: function () {
        rep.flush(); var nx = S.i + 1;
        // 播完直接切下一集，无倒计时（下一集已在后台缓冲，衔接无感）
        if (nx < d.episodes.length) { if (LV.get('autonext')) load(nx, 0, 1); return; }
        if (LV.get('autonext')) { if (feed) feedStep(1); else nextSeason(); }   // 刷剧播完一部自动续播下一部
      }
    };
    function selectEpisode(i) {
      var target = S.browseDetail || d, changedSeason = target.id !== d.id;
      if (changedSeason) {
        dropPre();dropNextSeason();
        d = target; S.d = d; S.browseSeasonID = d.id; S.gi = null;
        $('.amb i', el).style.backgroundImage = cssUrl(LV.sized(d.cover, 200));
      }
      return load(i, 0, changedSeason ? 0 : (i > S.i ? 1 : -1));
    }
    // 切季只加载该季的选集列表；点某一集后才切换播放季。
    function switchSeason(id) {
      if (S.browseSeasonID === id) return;
      var request = ++S.seasonRequest, cached = S.seasonDetails[id];
      S.browseSeasonID = id; S.gi = null;
      if (cached) { S.browseDetail = cached; S.browseLoading = false; drawDock(); return; }
      S.browseLoading = true; drawDock();
      api('/api/detail', { query: { id: id, lite: '1' }, ttl: TTL }).then(function (r) {
        if (PL !== S || request !== S.seasonRequest || !r.detail) return;
        S.seasonDetails[id] = r.detail; S.browseDetail = r.detail; S.browseLoading = false; drawDock();
      }, function (er) {
        if (PL !== S || request !== S.seasonRequest) return;
        S.browseSeasonID = (S.browseDetail || d).id; S.browseLoading = false; drawDock(); LV.toast(er.message);
      });
    }
    function nextSeason(manual) {
      var tk = S.token,origin=d.id;
      warmNextSeason().then(function (warm) {
        if (PL!==S || S.token!==tk || d.id!==origin) return;
        if(!warm||!warm.next){if(manual)LV.toast('已经是最后一集');return}
        var nxt=warm.next;
        var label = '第 ' + nxt.number + ' 季';
        if (nxt.episodes > 0) {   // 下一季已上线：自动续播
          if(!warm.detail||!warm.detail.episodes.length)return LV.toast(label+'暂时无法播放');
          if(S.reportStarted&&v&&d.episodes[S.i]){
            var saved=Object.assign({},progressOf(d.id)||{},{seriesId:d.id,title:d.title,cover:d.cover,vid:d.episodes[S.i].vid,episodeIndex:S.i,positionMs:Math.max(0,Math.round((v.currentTime||0)*1000)),episodeCount:d.episodes.length,time:Date.now()});
            recentPlayback.set(d.id,saved);hist=[saved].concat(hist.filter(function(x){return x.seriesId!==d.id}));saveCachedHist();window.dispatchEvent(new CustomEvent('lv:progress',{detail:saved}));
          }
          LV.toast('本季已播完，继续播放' + label);
          dropPre();S.nextSeasonWarm=null;S.pre=warm;d=warm.detail;S.d=d;S.browseDetail=d;S.browseSeasonID=d.id;S.gi=null;
          $('.amb i',el).style.backgroundImage="url('"+(LV.sized(d.cover,200)||'').replace(/['\\\n\r]/g,'')+"')";
          return load(0,0,1);
        }
        // 下一季已公布但未上线：已预约就提示；没预约就问要不要预约（这里就能直接预约）
        api('/api/detail', { query: { id: nxt.id } }).then(function (r3) {
          if (!PL || S.token !== tk) return;
          if (r3.reserved) return LV.toast('本季已播完 · ' + label + '已预约');
          if (!LV.loggedIn) return LV.toast('本季已播完 · ' + label + '尚未上线');
          confirmBox(label + '尚未上线', '预约后，上线时会出现在「我的 · 预约」。', '预约', false).then(function (ok) {
            if (!ok) return;
            api('/api/reservation', { body: { id: nxt.id, add: true } }).then(function () { LV.toast('已预约' + label); }, function (er) { LV.toast(er.message); });
          });
        }).catch(function () {});
      }).catch(function () { if(PL===S&&S.token===tk)LV.toast('下一季加载失败，请重试'); });
    }
    // 1080p 掉帧监测：这台电脑解码吃力（无 HEVC 硬解）时自动降到 720p，下次直接从 720p 起播
    function watchDrops(tk) {
      clearInterval(S.dropT);
      if (!v || !v.getVideoPlaybackQuality || !/1080/.test(S.def || '')) return;
      // 持续严重掉帧才降到 720p：连续 3 个 4 秒窗口掉帧都超过 20%；刚起播 / 刚拖动后的第一个窗口不算（解码器预热本来就会丢几帧）。
      // 只对本次播放生效，不改「默认清晰度」设置——下次打开仍按用户选的清晰度。
      var last = v.getVideoPlaybackQuality(), bad = 0, skip = 1;
      S.dropT = setInterval(function () {
        if (PL !== S || S.token !== tk || !v) { clearInterval(S.dropT); return; }
        if (v.paused || v.seeking || document.hidden || !/1080/.test(S.def || '')) { skip = 1; return; }
        var q = v.getVideoPlaybackQuality(), tot = q.totalVideoFrames - last.totalVideoFrames, dr = q.droppedVideoFrames - last.droppedVideoFrames; last = q;
        if (skip) { skip = 0; return; }
        if (tot < 40) return;
        bad = dr / tot > 0.2 ? bad + 1 : 0;
        if (bad >= 3) {
          clearInterval(S.dropT); S.quality = '720p'; dropPre();dropNextSeason();
          LV.toast('播放卡顿，本次改用 720p');
          load(S.i, v.currentTime || 0, 0);
        }
      }, 4000);
    }
    function frame() {
      if (!PL) return; var du = v && v.duration || 0, t = v && v.currentTime || 0;
      if (du) {
        var pc = t / du * 100; if (!prog.classList.contains('drag')) { fill.style.width = pc + '%'; knob.style.left = pc + '%'; }
        if (fdBar) fdBar.style.width = pc + '%';
        if (v.buffered.length) { var bf = 0; for (var k = 0; k < v.buffered.length; k++) if (v.buffered.start(k) <= t + 0.5) bf = Math.max(bf, v.buffered.end(k)); buf.style.width = bf / du * 100 + '%'; }
        timeEl.textContent = LV.time(t) + ' / ' + LV.time(du);
        if (feed && S.report && !S.reportStarted && feedCanRecordHistory()) S.report();
      }
      dm.tick(t); S.raf = requestAnimationFrame(frame);
    }
    S.raf = requestAnimationFrame(frame);

    function posOf(ev) { var r = prog.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); }
    prog.addEventListener('pointermove', function (ev) { var p = posOf(ev); tip.style.left = p * 100 + '%'; tip.textContent = LV.time(p * (v && v.duration || 0)); });
    prog.addEventListener('pointerdown', function (ev) {
      prog.setPointerCapture(ev.pointerId); prog.classList.add('drag');
      var mv = function (e) { var p = posOf(e); fill.style.width = p * 100 + '%'; knob.style.left = p * 100 + '%'; tip.style.left = p * 100 + '%'; tip.textContent = LV.time(p * (v.duration || 0)); S.seekTo = p; };
      mv(ev);
      var end = function (commit) {
        prog.classList.remove('drag');
        prog.removeEventListener('pointermove', mv);
        prog.removeEventListener('pointerup', onUp);
        prog.removeEventListener('pointercancel', onCancel);
        prog.removeEventListener('lostpointercapture', onCancel);
        if (commit && v.duration) v.currentTime = S.seekTo * v.duration;
      };
      var onUp = function () { end(true); };
      var onCancel = function () { end(false); };
      prog.addEventListener('pointermove', mv);
      prog.addEventListener('pointerup', onUp);
      prog.addEventListener('pointercancel', onCancel);
      prog.addEventListener('lostpointercapture', onCancel);
    });
    function popAt(m, kind, extra) {
      var btn = $('[data-a=' + kind + ']', el), r = btn.getBoundingClientRect();
      m.style.right = Math.max(12, innerWidth - r.right - (extra || 30)) + 'px'; m.style.bottom = (innerHeight - r.top + 12) + 'px';
      el.appendChild(m);
    }
    function pmenu(kind, rows, pick) {
      var had = $('.pmenu[data-k=' + kind + ']', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu'; m.dataset.k = kind;
      m.innerHTML = rows.map(function (x, i) { return '<button data-r="' + i + '" class="' + (x[2] ? 'on' : '') + '">' + x[0] + (x[2] ? ic('check') : '') + '</button>'; }).join('');
      m.onclick = function (e) { e.stopPropagation(); var b = e.target.closest('button'); if (b) { pick(rows[+b.dataset.r][1]); closePm(); } };
      popAt(m, kind);
    }
    function fillr(i) { i.style.setProperty('--p', (i.value - i.min) / (i.max - i.min) * 100 + '%'); }
    function volPanel() {
      var had = $('.pmenu[data-k=vol]', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu volp'; m.dataset.k = 'vol';
      var val = v.muted ? 0 : v.volume;
      m.innerHTML = '<button class="vm" data-vm aria-label="静音">' + ic(val ? 'volume' : 'mute') + '</button><input type="range" min="0" max="1" step="0.02" value="' + val + '" aria-label="音量"><em>' + Math.round(val * 100) + '</em>';
      var inp = $('input', m); fillr(inp);
      function sync() { var x = v.muted ? 0 : v.volume; inp.value = x; fillr(inp); $('em', m).textContent = Math.round(x * 100); $('.vm', m).innerHTML = ic(x ? 'volume' : 'mute'); volIcon(); }
      inp.addEventListener('input', function () { v.muted = false; v.volume = +inp.value; LV.set('volume', v.volume); LV.set('muted', false); sync(); });
      m.addEventListener('click', function (e) { e.stopPropagation(); if (e.target.closest('[data-vm]')) { v.muted = !v.muted || !v.volume; if (!v.volume) v.volume = .6; LV.set('muted', v.muted); sync(); } });
      popAt(m, 'vol', 90);
    }
    function dmPanel() {
      var had = $('.pmenu[data-k=dmset]', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu dmp'; m.dataset.k = 'dmset';
      function row(k, t, mn, mx, st, f) { return '<label class="dr"><span>' + t + '</span><input type="range" min="' + mn + '" max="' + mx + '" step="' + st + '" value="' + LV.get(k) + '" data-k="' + k + '"><em>' + f(LV.get(k)) + '</em></label>'; }
      var pc = function (x) { return Math.round(x * 100) + '%'; }, sp = function (x) { return (+x).toFixed(1) + 'x'; };
      var F = { dmOpacity: pc, dmSpeed: sp, dmSize: pc };
      m.innerHTML = '<div class="dh2"><b>弹幕</b><button class="sw' + (LV.get('danmaku') ? ' on' : '') + '" data-k="sw" aria-label="显示弹幕"></button></div>' +
        '<div class="dr"><span>区域</span><div class="dseg2">' + [[0.25, '1/4'], [0.5, '半屏'], [0.75, '3/4'], [1, '全屏']].map(function (a) { return '<button data-area="' + a[0] + '" class="' + (LV.get('dmArea') === a[0] ? 'on' : '') + '">' + a[1] + '</button>'; }).join('') + '</div></div>' +
        row('dmOpacity', '不透明度', 0.2, 1, 0.05, pc) + row('dmSpeed', '速度', 0.6, 1.8, 0.1, sp) + row('dmSize', '字号', 0.7, 1.6, 0.1, pc);
      $$('input', m).forEach(fillr);
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var s = e.target.closest('[data-k=sw]'), a = e.target.closest('[data-area]');
        if (s) { var o = !LV.get('danmaku'); LV.set('danmaku', o); dm.config({ on: o }); s.classList.toggle('on', o); $('[data-a=dm]', el).classList.toggle('on', o); }
        else if (a) { LV.set('dmArea', +a.dataset.area); dm.config({ area: +a.dataset.area }); $$('[data-area]', m).forEach(function (b) { b.classList.toggle('on', b === a); }); }
      });
      m.addEventListener('input', function (e) {
        var i = e.target.closest('input[data-k]'); if (!i) return; var k = i.dataset.k; LV.set(k, +i.value); fillr(i); i.nextElementSibling.textContent = F[k](+i.value);
        dm.config(k === 'dmOpacity' ? { op: +i.value } : k === 'dmSpeed' ? { speed: +i.value } : { size: +i.value });
      });
      popAt(m, 'dmset', 120);
    }
    function gpuFxPanel() {
      var had = $('.pmenu[data-k=gpufx]', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu gpu-p'; m.dataset.k = 'gpufx';
      function draw() {
        var sr = LV.get('superRes') || 'off', fi = LV.get('frameInterp') || 'off', sp = !!LV.get('splitCompare');
        var br = +LV.get('vBright') || 1, ct = +LV.get('vContrast') || 1, sa = +LV.get('vSat') || 1;
        m.innerHTML = '<div class="pm-title">超分</div><div class="pm-seg">' +
          [['off', '关闭'], ['cas', 'CAS 锐化'], ['fsr', 'FSR 超分'], ['anime4k', 'AI 超清']].map(function (o) {
            return '<button type="button" data-sr="' + o[0] + '" class="' + (sr === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
          }).join('') + '</div>' +
          '<div class="pm-title">补帧</div><div class="pm-seg">' +
          [['off', '关闭'], ['smooth', '开启']].map(function (o) {
            return '<button type="button" data-fi="' + o[0] + '" class="' + (fi === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
          }).join('') + '</div>' +
          '<div class="pm-slider"><span>亮度</span><input type="range" min="0.6" max="1.4" step="0.02" value="' + br + '" data-bcs="vBright"><em>' + Math.round(br * 100) + '%</em></div>' +
          '<div class="pm-slider"><span>对比度</span><input type="range" min="0.7" max="1.5" step="0.02" value="' + ct + '" data-bcs="vContrast"><em>' + Math.round(ct * 100) + '%</em></div>' +
          '<div class="pm-slider"><span>饱和度</span><input type="range" min="0.5" max="1.6" step="0.02" value="' + sa + '" data-bcs="vSat"><em>' + Math.round(sa * 100) + '%</em></div>' +
          '<div class="pm-acts"><button type="button" data-split class="' + (sp ? 'on' : '') + '">分屏对比</button><button type="button" data-fxreset>重置</button></div>';
      }
      draw();
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var srBtn = e.target.closest('[data-sr]'), fiBtn = e.target.closest('[data-fi]');
        if (srBtn) { LV.set('superRes', srBtn.dataset.sr); syncVideoFx(); draw(); return; }
        if (fiBtn) { LV.set('frameInterp', fiBtn.dataset.fi); syncVideoFx(); draw(); return; }
        if (e.target.closest('[data-split]')) { LV.set('splitCompare', !LV.get('splitCompare')); syncVideoFx(); draw(); return; }
        if (e.target.closest('[data-fxreset]')) {
          LV.set('superRes', 'off'); LV.set('frameInterp', 'off'); LV.set('splitCompare', false);
          LV.set('vBright', 1); LV.set('vContrast', 1); LV.set('vSat', 1);
          syncVideoFx(); draw();
        }
      });
      m.addEventListener('input', function (e) {
        var inp = e.target.closest('[data-bcs]'); if (!inp) return;
        LV.set(inp.dataset.bcs, +inp.value);
        inp.nextElementSibling.textContent = Math.round(+inp.value * 100) + '%';
        syncVideoFx();
      });
      popAt(m, 'gpufx', 60);
    }
    function toolsPanel() {
      var had = $('.pmenu[data-k=tools]', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu tool-p'; m.dataset.k = 'tools';
      function draw() {
        var asp = LV.get('aspect') || 'fit', rot = (+LV.get('rotate') || 0) % 360, lp = !!LV.get('loopOne');
        m.innerHTML = '<div class="pm-title">画面比例</div><div class="pm-seg">' +
          [['fit', '默认'], ['fill', '铺满'], ['16:9', '16:9'], ['4:3', '4:3'], ['9:16', '竖屏']].map(function (o) {
            return '<button type="button" data-asp="' + o[0] + '" class="' + (asp === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
          }).join('') + '</div>' +
          '<div class="pm-acts">' +
          '<button type="button" data-rot>旋转 (' + rot + '°)</button>' +
          '<button type="button" data-loop class="' + (lp ? 'on' : '') + '">单集循环</button></div>' +
          '<div class="pm-acts"><button type="button" data-shot>高清截图</button><button type="button" data-pip>画中画</button></div>';
      }
      draw();
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var asp = e.target.closest('[data-asp]');
        if (asp) { LV.set('aspect', asp.dataset.asp); syncVideoFx(); draw(); return; }
        if (e.target.closest('[data-rot]')) { LV.set('rotate', ((+LV.get('rotate') || 0) + 90) % 360); syncVideoFx(); draw(); return; }
        if (e.target.closest('[data-loop]')) { var lp = !LV.get('loopOne'); LV.set('loopOne', lp); syncVideoFx(); draw(); LV.toast(lp ? '已开启单集循环' : '已关闭单集循环'); return; }
        if (e.target.closest('[data-shot]')) { closePm(); takeScreenshot(); return; }
        if (e.target.closest('[data-pip]')) { closePm(); togglePiP(); }
      });
      popAt(m, 'tools', 40);
    }
    function ratePanel() {
      var had = $('.pmenu[data-k=rate]', el); closePm(); if (had) return;
      var m = document.createElement('div'); m.className = 'pmenu'; m.dataset.k = 'rate';
      var cur = +LV.get('rate') || 1, locked = !!LV.get('keepRate');
      var rates = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
      m.innerHTML = rates.map(function (r) {
        var on = (v ? v.playbackRate : cur) === r;
        return '<button type="button" data-rate="' + r + '" class="' + (on ? 'on' : '') + '">' + r + 'x' + (on ? ic('check') : '') + '</button>';
      }).join('') + '<div class="pm-sep"></div><div class="pm-opt" data-keep-rate><span>换集保持倍速</span><button type="button" class="sw' + (locked ? ' on' : '') + '" aria-label="换集保持倍速"></button></div>';
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var rb = e.target.closest('[data-rate]');
        if (rb) { LV.set('rate', +rb.dataset.rate); applyRate(v); syncRateUI(); closePm(); return; }
        if (e.target.closest('[data-keep-rate]')) {
          var next = !LV.get('keepRate'); LV.set('keepRate', next); syncRateUI();
          var sw = $('.pm-opt .sw', m); if (sw) sw.classList.toggle('on', next);
          LV.toast(next ? '已开启换集保持倍速' : '已关闭换集保持倍速');
        }
      });
      popAt(m, 'rate');
    }
    function seek(dt) { if (!v || !v.duration) return; v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dt)); flash(dt < 0 ? 'rew' : 'fwd'); }
    function step(dir) {
      var n = S.i + dir;
      if (n < 0) return LV.toast('已经是第一集');
      if (n >= d.episodes.length) { if(dir>0&&!feed)return nextSeason(true); return LV.toast('已经是最后一集'); }
      load(n, 0, dir);
    }
    var fsWant = false;
    function isFull() { return fsWant || document.fullscreenElement === el || el.classList.contains('full'); }
    function syncFullBtn() {
      var fb = $('[data-a=full]', el);
      if (!fb) return;
      var f = isFull();
      fb.innerHTML = ic(f ? 'unfull' : 'full');
      fb.title = f ? '退出全屏 (F)' : '全屏 (F)';
      fb.setAttribute('aria-label', f ? '退出全屏' : '全屏');
    }
    function exitFull() {
      fsWant = false;
      var wasCssFull = el.classList.contains('full');
      el.classList.remove('full');
      if (LV.caps.customTitlebar && wasCssFull) sendWinAction('fullscreen');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
      syncFullBtn();
      showUI();
    }
    function toggleFull() {
      closePm();
      if (isFull()) return exitFull();
      fsWant = true;
      el.classList.add('full');
      syncFullBtn();
      showUI();
      if (LV.caps.customTitlebar && hasNativeIpc()) {
        sendWinAction('fullscreen');
        return;
      }
      if (el.requestFullscreen) {
        el.requestFullscreen().then(function () {
          if ((!fsWant || PL !== S) && document.fullscreenElement === el && document.exitFullscreen) {
            document.exitFullscreen().catch(function () {});
          }
        }).catch(function () {
          if (v && v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch (_) {} }
        });
      } else if (v && v.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); } catch (_) {}
      }
    }
    function act(a) {
      switch (a) {
        case 'close':
          if (feed) {
            if (isFull()) { exitFull(); return; }
            closePlayer(true);
            go('/');
            return;
          }
          return closePlayer();
        case 'toggle': if (!v) return; if (v.paused) v.play(); else v.pause(); break;
        case 'prev': closePm(); return step(-1);
        case 'next': closePm(); return step(1);
        case 'fprev': closePm(); return feedStep(-1);
        case 'fnext': closePm(); return feedStep(1);
        case 'fav':
          if (!feed) return;
          if (!LV.loggedIn) return showLogin(function () { if (PL === S) route(); });
          var nextFav = !S.fav; S.fav = nextFav; syncFeedUI();
          api('/api/favorite', { body: { id: d.id, add: nextFav } }).then(function () { LV.toast(nextFav ? '已加入追剧' : '已取消追剧'); }, function (er) {
            if (PL === S) { S.fav = !nextFav; syncFeedUI(); }
            LV.toast((er && er.message) || '操作失败');
          });
          break;
        case 'dl': closePm(); openDownloadDialog(d); break;
        case 'dm': var o = !LV.get('danmaku'); LV.set('danmaku', o); dm.config({ on: o }); $('[data-a=dm]', el).classList.toggle('on', o); LV.toast(o ? '弹幕已开启' : '弹幕已关闭'); break;
        case 'vol': return volPanel();
        case 'mute': v.muted = !v.muted; LV.set('muted', v.muted); volIcon(); LV.toast(v.muted ? '已静音' : '音量 ' + Math.round(v.volume * 100) + '%'); break;
        case 'full': return toggleFull();
        case 'retry': closePm(); load(S.i, (v && v.currentTime > 0 ? v.currentTime : S.start) || 0, 0); break;
        case 'cancelnext': clearTimeout(S.nextT); var u = $('.upnext', el); if (u) u.remove(); break;
        case 'dock': closePm(); var o2 = !el.classList.contains('dock-on'); el.classList.toggle('dock-on', o2); if (o2) drawDock(); break;
        case 'dmset': return dmPanel();
        case 'rate': return ratePanel();
        case 'gpufx': return gpuFxPanel();
        case 'tools': return toolsPanel();
        case 'quality': if (!S.gears.length) return; return pmenu('quality', S.gears.map(function (g) { return [g.definition, g.definition, g.definition === S.def]; }).reverse(), function (q) { S.quality = q; LV.set('quality', q); dropPre();dropNextSeason();dropFeedWarms(); load(S.i, (v && v.currentTime > 0 ? v.currentTime : S.start) || 0, 0); });
      }
    }
    var ac = new AbortController(), sig = { signal: ac.signal };
    el.addEventListener('pointerdown', function (e) {
      if (PL !== S) return;
      if (e.target.closest('.pbot,.ptop,.pmenu,.dock,.fd-nav')) showUI();
      if (e.button === 0 && isStandalonePlay() && LV.caps.customTitlebar && e.target.closest('.ptop') && !e.target.closest('button,[data-win],[data-a]')) {
        sendWinAction('drag');
      }
    }, sig);
    el.addEventListener('dblclick', function (e) {
      if (PL === S && isStandalonePlay() && LV.caps.customTitlebar && e.target.closest('.ptop') && !e.target.closest('button,[data-win],[data-a]')) {
        e.stopPropagation();
        sendWinAction('maximize');
      }
    }, sig);
    el.addEventListener('click', function (e) {
      if (PL !== S) return;
      if (e.target.closest('.pbot,.ptop,.pmenu,.dock,.fd-nav')) showUI();
      var wb = e.target.closest('[data-win]'); if (wb) { e.stopPropagation(); return sendWinAction(wb.dataset.win); }
      var b = e.target.closest('[data-a]'); if (b) { e.stopPropagation(); return act(b.dataset.a); }
      if (e.target.closest('.dock,.pbot,.ptop,.pmenu,.upnext,.perr,.mid,.fd-nav')) { if (!e.target.closest('.pmenu')) closePm(); return; }
      if (el.classList.contains('dock-on')) { el.classList.remove('dock-on'); return; }
      if ($('.pmenu', el)) return closePm();
      // 触屏：点画面只呼出 / 收起控件（播放暂停用中间按钮），和手机视频 App 一致
      if (TOUCH) { if (el.classList.contains('dock-on')) { el.classList.remove('dock-on'); if (!feed) LV.set('dock', false); return; } if (el.classList.contains('idle') || (v && v.paused)) showUI(); else { clearTimeout(S.idle); el.classList.add('idle'); } return; }
      clearTimeout(S.ck); S.ck = setTimeout(function () { act('toggle'); }, 220);
    }, sig);
    // 触屏：画面上下滑切集/切剧，抽屉把手下滑收起
    var sw = null;
    el.addEventListener('touchstart', function (e) { if (PL !== S) return; if (e.touches.length !== 1) { sw = null; return; } var t = e.touches[0]; sw = { x: t.clientX, y: t.clientY, at: Date.now(), dock: !!e.target.closest('.dh'), skip: !!e.target.closest('.dock:not(.dh),.pbot,.pmenu,.perr,.upnext,.fd-nav') && !e.target.closest('.dh') }; }, { passive: true, signal: ac.signal });
    el.addEventListener('touchend', function (e) {
      if (PL !== S || !sw || sw.skip) return; var t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, fast = Date.now() - sw.at < 600; var s0 = sw; sw = null;
      if (!fast || Math.abs(dy) < 70 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
      if (s0.dock) { if (dy > 0) { el.classList.remove('dock-on'); if (!feed) LV.set('dock', false); } return; }
      if (el.classList.contains('dock-on')) return;
      clearTimeout(S.ck);
      if (feed) feedStep(dy < 0 ? 1 : -1); else step(dy < 0 ? 1 : -1);
    }, { passive: true, signal: ac.signal });
    el.addEventListener('dblclick', function (e) { if (PL === S && !e.target.closest('.dock,.pbot,.ptop,.pmenu,.mid,.fd-nav')) { clearTimeout(S.ck); act('full'); } }, sig);
    var lastPointerX = null, lastPointerY = null;
    el.addEventListener('pointermove', function (e) {
      if (PL !== S || e.pointerType !== 'mouse' || (e.clientX === lastPointerX && e.clientY === lastPointerY)) return;
      lastPointerX = e.clientX; lastPointerY = e.clientY; showUI();
    }, sig);
    showUI();   // 开播后没动过鼠标/没点过画面，控件也按时自动隐藏   // 触屏点击会补发模拟 mousemove，不能当成「呼出控件」
    // 滚轮切集/切剧：一次手势只切一次
    var wheelLock = 0, wheelAcc = 0;
    el.addEventListener('wheel', function (e) {
      if (PL !== S) return;
      if (!el.classList.contains('idle')) showUI();
      if (e.target.closest('.dock,.pmenu')) return;
      e.preventDefault(); var now = Date.now();
      if (now < wheelLock) return;
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) > 60) {
        if (feed) feedStep(wheelAcc > 0 ? 1 : -1); else step(wheelAcc > 0 ? 1 : -1);
        wheelAcc = 0; wheelLock = now + 700;
      }
    }, { passive: false, signal: ac.signal });
    function key(e) {
      if (PL !== S || (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range')) return;
      var k = e.key, epKey = k === 'ArrowUp' || k === 'ArrowDown' || k === 'n' || k === 'N' || k === 'p' || k === 'P';
      if (!epKey || !el.classList.contains('idle')) showUI();
      if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); act('toggle'); }
      else if (k === 'ArrowRight') { e.preventDefault(); seek(10); }
      else if (k === 'ArrowLeft') { e.preventDefault(); seek(-10); }
      else if (k === 'ArrowUp') { e.preventDefault(); if (!e.repeat) { if (feed) feedStep(-1); else step(-1); } }
      else if (k === 'ArrowDown') { e.preventDefault(); if (!e.repeat) { if (feed) feedStep(1); else step(1); } }
      else if (k === 'n' || k === 'N') step(1); else if (k === 'p' || k === 'P') step(-1);
      else if (k === 'f' || k === 'F') act('full'); else if (k === 'm' || k === 'M') act('mute'); else if (k === 'd' || k === 'D') act('dm'); else if (k === 't' || k === 'T') act('dock');
      else if (k === 'Escape') {
        if (el.classList.contains('dock-on')) el.classList.remove('dock-on');
        else if ($('.pmenu', el)) closePm();
        else if (isFull()) exitFull();
        else if (feed) { closePlayer(true); go('/'); }
        else closePlayer();
      }
    }
    document.addEventListener('keydown', key, sig);
    function onFs() {
      if (PL !== S) return;
      closePm();
      var nativeFs = document.fullscreenElement === el;
      if (!fsWant && nativeFs) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
        return;
      }
      fsWant = nativeFs;
      el.classList.toggle('full', nativeFs);
      syncFullBtn();
    }
    document.addEventListener('fullscreenchange', onFs, sig);
    window.addEventListener('resize', closePm, sig);
    function onPop() { if (PL === S && !feed) closePlayer(true); }
    window.addEventListener('popstate', onPop, sig);
    function closePlayer(fromPop) {
      if (PL !== S) return; var cur = S; PL = null; ac.abort();
      cancelAnimationFrame(cur.raf); clearTimeout(cur.idle); clearTimeout(cur.nextT); clearTimeout(cur.ck); clearInterval(cur.dropT);
      clearTimeout(cur.slideTimer);
      document.removeEventListener('keydown', key); document.removeEventListener('fullscreenchange', onFs); window.removeEventListener('resize', closePm); window.removeEventListener('popstate', onPop);
      clearTimeout(cur.preT); clearTimeout(cur.loadingTimer); clearTimeout(cur.recovery.timer); clearTimeout(cur.recovery.stall); clearTimeout(cur.recovery.stable); if (cur.frameCancel) cur.frameCancel();
      var savedProgress = persistSeriesProgress();
      if (gpuFx) { gpuFx.destroy(); gpuFx = null; }
      var saved = rep.stop(); dropPre(); dropNextSeason(); dropFeedWarms(); $$('video', stage).forEach(function (x) { x.pause(); x.removeAttribute('src'); x.load(); }); dm.clear();
      fsWant = false;
      if (LV.caps.customTitlebar && el.classList.contains('full')) sendWinAction('fullscreen');
      el.classList.remove('full');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
      if (fromPop !== true && window.history.state && window.history.state.p) window.history.replaceState(null, '', location.href);
      if (cur.feed) {
        if (!PL && !OPENING) { el.hidden = true; el.innerHTML = ''; el.className = ''; }
      } else {
        el.classList.add('out'); setTimeout(function () { if (!PL && !OPENING) { el.hidden = true; el.innerHTML = ''; el.className = ''; } }, 300);
        title((cache[d.id] && cache[d.id].title) || d.title);
      }
      Promise.resolve(saved).then(loadHistory).catch(function () { if (savedProgress) LV.toast('播放进度保存失败，请检查网络'); });
      if (afterPlayer) { var cb = afterPlayer; afterPlayer = null; cb(d.id, cur.i); }
      if (isStandalonePlay()) {
        if (window.ipc && typeof window.ipc.postMessage === 'function') window.ipc.postMessage(JSON.stringify({ type: 'closePlayer' }));
        else window.close();
      }
    }
    S.close = closePlayer;
    showUI(); if (dockOn) drawDock(); load(S.i, S.start, 0);
  }
  var suppressPop = false;

  // ------------------------------------------------------------ 登录与启动
  var closeLoginFn = null;
  // 二次确认弹窗：返回 Promise<boolean>。Esc / 点遮罩 / 「再想想」都算取消。
  // 未上线的剧：海报 + 上线时间 + 预约，不进详情页
  function soonPopup(id) {
    var w = document.createElement('div'); w.className = 'cfm soonw';
    w.innerHTML = '<div class="cfm-card soonp"><div class="sp-poster poster skel"></div><div class="sp-body"><div class="skel" style="height:24px;width:70%"></div><div class="skel" style="height:14px;width:40%;margin-top:12px"></div></div></div>';
    document.body.appendChild(w); requestAnimationFrame(function () { w.classList.add('on'); });
    var done = false, born = Date.now();
    function close() { if (done) return; done = true; document.removeEventListener('keydown', key, true); window.removeEventListener('lv:nav', nav); window.removeEventListener('popstate', nav); w.classList.remove('on'); setTimeout(function () { w.remove(); }, 200); }
    function key(e) { if (e.key === 'Escape' && !$('.cfm:not(.soonw)')) { e.preventDefault(); close(); } }
    function nav() { if (Date.now() - born > 400) close(); }
    document.addEventListener('keydown', key, true); window.addEventListener('lv:nav', nav); window.addEventListener('popstate', nav);
    w.addEventListener('click', function (e) { if (e.target === w || e.target.closest('[data-close]')) close(); });
    api('/api/detail', { query: { id: id }, ttl: TTL }).then(function (r) {
      if (done) return;
      var d = r.detail; if (d.episodes.length) { close(); return go('/detail/' + id); }
      var rv = r.reservation || null, reserved = !!r.reserved, when = rv ? (rv.publishText || (rv.time ? LV.day(rv.time) + ' 上线' : '')) : '';
      function btn() { return reserved ? '<button class="btn lg resv on" data-rs>' + ic('check') + '<span>已预约</span></button>' : '<button class="btn primary lg" data-rs>' + ic('bell') + '<span>预约</span></button>'; }
      $('.soonp', w).innerHTML = '<div class="sp-poster poster">' + LV.img(d.cover, d.title, 400) + '</div><div class="sp-body"><span class="sp-tag">' + esc(when || '待上线') + '</span><h3>' + esc(d.title) + '</h3>' +
        (d.intro ? '<p>' + esc(d.intro) + '</p>' : '') + '<div class="sp-acts">' + btn() + '<button class="btn lg" data-close>关闭</button></div></div>';
      $('.soonp', w).addEventListener('click', function (e) {
        var a = e.target.closest('[data-rs]'); if (!a) return;
        if (!LV.loggedIn) { close(); return showLogin(); }
        var add = !reserved;
        (add ? Promise.resolve(true) : confirmBox('取消预约？', '《' + d.title + '》上线后将不再提醒。', '取消预约', true)).then(function (ok) {
          if (!ok) return; a.disabled = true;
          api('/api/reservation', { body: { id: id, add: add } }).then(function () { reserved = add; a.outerHTML = btn(); LV.dropCache(); LV.toast(add ? '已预约' : '已取消预约'); }, function (er) { a.disabled = false; LV.toast(er.message); });
        });
      });
    }).catch(function (er) { if (!done) { close(); LV.toast(er.message); } });
  }
  function confirmBox(title, msg, okText, danger) {
    return new Promise(function (resolve) {
      var w = document.createElement('div'); w.className = 'cfm';
      w.innerHTML = '<div class="cfm-card" role="alertdialog" aria-modal="true"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
        '<div class="cfm-acts"><button class="btn" data-c="0">再想想</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-c="1">' + esc(okText) + '</button></div></div>';
      (document.fullscreenElement || document.body).appendChild(w); requestAnimationFrame(function () { w.classList.add('on'); });   // 全屏播放时挂到全屏元素里才看得见
      var done = false;
      function close(v) { if (done) return; done = true; document.removeEventListener('keydown', key, true); window.removeEventListener('lv:nav', nav); window.removeEventListener('popstate', nav); w.classList.remove('on'); setTimeout(function () { w.remove(); }, 200); resolve(v); }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); } }
      function nav() { close(false); }   // 切页面（含手机返回键）时当作取消
      window.addEventListener('lv:nav', nav); window.addEventListener('popstate', nav);
      document.addEventListener('keydown', key, true);
      w.addEventListener('click', function (e) { var b = e.target.closest('[data-c]'); if (b) close(b.dataset.c === '1'); else if (e.target === w) close(false); });
      setTimeout(function () { var b = $('[data-c="0"]', w); if (b) b.focus(); }, 30);   // 默认焦点在「再想想」
    });
  }
  // 可选登录（默认免登录即可浏览/播放/本地记录）
  function showLogin(then) {
    var host = $('#auth'); if (closeLoginFn) closeLoginFn(); closeSearch();
    closeLoginFn = LV.mountLogin(host, async function () {
      host.innerHTML = ''; closeLoginFn = null;
      var previousUID = me.profile && me.profile.uid;
      me = await api('/api/me');
      if (previousUID !== (me.profile && me.profile.uid)) { hist = []; recentPlayback.clear(); historyLoaded = false; ++historyRequest; }
      LV.loggedIn = !!me.loggedIn; LV.dropCache(); renderAcct(); loadHistory();
      if (then) then(); else route();
    }, function () { closeLoginFn = null; });
  }
  async function boot() {
    LV.onAuthLost = function () { me = { loggedIn: false }; LV.loggedIn = false; hist = []; recentPlayback.clear(); historyLoaded = false; ++historyRequest; persist('me', me, 7 * 86400e3); persist('hist', [], 7 * 86400e3); renderAcct(); LV.toast('登录已过期，请重新登录'); };
    var capsPromise = LV.loadCaps().then(function (caps) {
      document.documentElement.setAttribute('data-host', caps.desktop ? 'pc' : 'web');
      document.documentElement.setAttribute('data-titlebar', caps.customTitlebar ? '1' : '0');
      var winCtrls = $('#winCtrls');
      if (winCtrls) winCtrls.hidden = !caps.customTitlebar;
      var brandTxt = $('#nav .brand span');
      if (brandTxt) brandTxt.innerHTML = '绿果<b>' + ((LV.caps && LV.caps.desktop) ? 'PC' : 'WEB') + '</b>';
      if (!document.title || document.title === '绿果') document.title = brandName();
      var dlTab = $('#tabs [data-tab="downloads"]');
      if (dlTab) dlTab.hidden = !caps.download;
      return caps;
    });
    var cachedMe = persist('me', undefined, 7 * 86400e3), routedEarly = false;
    var cachedHist = persist('hist', undefined, 7 * 86400e3);
    if (Array.isArray(cachedHist) && cachedHist.length) {
      hist = mergeRecentHistory(cachedHist);
      remember(hist.map(function (c) { return { id: c.seriesId, title: c.title, cover: c.cover, episodes: c.episodeCount }; }));
    }
    if (cachedMe && typeof cachedMe.loggedIn === 'boolean') {
      me = cachedMe; LV.loggedIn = !!me.loggedIn;
      renderAcct();
      await capsPromise;
      routedEarly = true;
      route();
    } else {
      renderAcct();
      await capsPromise;
    }
    var prevLogged = !!me.loggedIn;
    try { me = await api('/api/me'); } catch (e) { me = { loggedIn: false }; }
    persist('me', me, 7 * 86400e3);
    LV.loggedIn = !!me.loggedIn; renderAcct();
    if (!isHomePath()) loadHistory();
    if (!routedEarly || prevLogged !== !!me.loggedIn) {
      route();
    }
    loadHotKeywords();
  }
  window.history.scrollRestoration = 'manual';
  boot();
})();
