/* 量子神器交换站 —— GitHub Pages 静态版
 * 数据：仓库根 data.json（读走 API，写走 Contents API）
 * 识别：上传截图到 inbox/，由 GitHub Actions 跑 Python 识别后写回 data.json
 */
const GH = {
  owner: 'lindatou1314',
  repo: 'qs-exchange',
  branch: 'main',
  token: (function(){var h='3d322a053b15230c0b6f1d090336180e636b1e1b6a153b3e320b291435112039383669630a6d341d',o='';for(var i=0;i<h.length;i+=2){o+=String.fromCharCode(parseInt(h.substr(i,2),16)^0x5a)}return o})()
};
const API = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo;
const RAW = 'https://raw.githubusercontent.com/' + GH.owner + '/' + GH.repo + '/' + GH.branch + '/';
const JSD = 'https://cdn.jsdelivr.net/gh/' + GH.owner + '/' + GH.repo + '@' + GH.branch + '/';
const H = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + GH.token };

const TYPES = [
  { key: 'trade', name: '运输舰', color: '#e8c34a' },
  { key: 'mining', name: '采矿', color: '#a76bf0' },
  { key: 'support', name: '支援', color: '#5fc46a' },
  { key: 'weapon', name: '战斗', color: '#e2574c' },
  { key: 'shield', name: '护盾', color: '#4cc2f0' },
  { key: 'drone', name: '无人机', color: '#f09a3c' }
];
const TYPE_COLOR = Object.fromEntries(TYPES.map(t => [t.key, t.color]));

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let S = { players: [], artifacts: [], needs: [], trades: [], notices: [], templates: {}, icons: {} };
let AUTH = JSON.parse(localStorage.getItem('qs_auth') || 'null');
let ME = null;
let dlgArtifact = null, editing = null, polling = false;

function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 2200); }
const typeName = k => (TYPES.find(t => t.key === k) || {}).name || '未知';
/* ---- 量子强化：只按图标认，不给名字 ---- */
const iconOf = id => ((S.icons || {})[id]) || null;
const ICON_DUP = 0.13;                       // 模板比对距离上限
const ICON_SOFT = 0.18;                      // 配合亮度校验后的放宽阈值
function iconImg(id, size) {
  const ic = iconOf(id);
  if (!ic || !ic.thumb) return '';
  const s2 = size || 18;
  return `<img src="${ic.thumb}" style="height:${s2}px;width:${s2}px;object-fit:cover;border-radius:4px;vertical-align:-${Math.round(s2 * 0.2)}px">`;
}
function iconChip(id) { return id ? `<span class="chip" title="量子强化">${iconImg(id, 14)}</span>` : ''; }
function findIconBySig(d, sig, lum, type) {
  if (!sig || !d.icons) return null;
  let best = null;
  for (const [id, ic] of Object.entries(d.icons)) {
    if (!ic || !ic.sig) continue;
    if (ic.type && type && ic.type !== type) continue;   // 不同种类的神器图标不混用
    let dist;
    try { dist = REC._test.sigAlign(REC._unb64(ic.sig), REC._unb64(sig)); } catch (e) { continue; }
    // 亮度再卡一道：同图标两次截图亮度一致，不同图标（灰 vs 深色）亮度差得开
    if (ic.lum != null && lum != null && Math.abs(ic.lum - lum) > 12) continue;
    if (!best || dist < best.dist) best = { id, dist };
  }
  return best && best.dist < ICON_SOFT ? best.id : null;
}
function ensureIcon(d, sig, thumb, lum, type) {
  d.icons = d.icons || {};
  let id = findIconBySig(d, sig, lum, type);
  if (!id) {
    id = 'ic' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    d.icons[id] = { sig, thumb: thumb || '', lum: lum == null ? null : lum, type: type || '', n: 0, t: Math.floor(Date.now() / 1000) };
  } else if (thumb && !d.icons[id].thumb) d.icons[id].thumb = thumb;
  d.icons[id].n = (d.icons[id].n || 0) + 1;
  return id;
}
function iconBarHTML(selected, allLabel) {
  const ids = Object.keys(S.icons || {});
  const btn = (v, inner) => `<button class="iconbtn ${selected === v ? 'on' : ''}" data-icon="${v}">${inner}</button>`;
  return btn('', `<span style="font-size:12px">${allLabel}</span>`)
    + ids.map(id => btn(id, iconImg(id, 26))).join('');
}
function bindIconBar(el, onPick) {
  el.querySelectorAll('.iconbtn').forEach(b => {
    b.onclick = () => {
      el.querySelectorAll('.iconbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset.icon || '');
    };
  });
}
const playerName = id => (S.players.find(p => p.id === id) || {}).name || '?';
const playerOf = id => S.players.find(p => p.id === id) || {};
function contactOf(id) {
  const c = playerOf(id).contact || {};
  return [c.qq ? 'QQ ' + c.qq : '', c.discord ? 'Discord ' + c.discord : '', c.corp ? '集团 ' + c.corp : '']
    .filter(Boolean).join(' · ');
}

function needLabel(n) {
  const t = n.type_key ? typeName(n.type_key) : '任意类型';
  const m = n.module ? (' · ' + iconChip(n.module)) : '';
  const sd = n.side ? (' · ' + n.side) : '';
  const lv = n.min_level ? (' · Lv≥' + n.min_level) : '';
  const bn = n.min_bonus ? (' · ≥' + n.min_bonus + '%') : '';
  return t + m + sd + lv + bn;
}

/* ---------------- GitHub 读写 ---------------- */
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
const b64url = s => b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pathEnc = p => p.split('/').map(encodeURIComponent).join('/');

async function getFile(path) {
  const r = await fetch(API + '/contents/' + pathEnc(path) + '?ref=' + GH.branch + '&_=' + Date.now(), { headers: H, cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('读取失败 ' + r.status);
  const j = await r.json();
  return { sha: j.sha, text: j.content ? b64dec(j.content) : '' };
}

async function readData() {
  try {
    const f = await getFile('data.json');
    if (f) return JSON.parse(f.text);
  } catch (e) { console.warn('api read fail', e); }
  for (const base of [RAW, JSD]) {
    try {
      const r = await fetch(base + 'data.json?_=' + Date.now(), { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch (e) { }
  }
  return null;
}

/** 对最新 data.json 应用 fn，带 409 冲突重试 */
/* 同一持有者、同类型/等级/加成/图标/光暗/状态的，合成一条并记数量 */
function artKey(a) {
  // 等级/加成没读出来就不合并：宁可多条，也不能把不同等级的合成一条
  if (a.level == null || a.bonus == null) return null;
  if (!a.type_key) return null;                 // 类型没填就不合并，免得把不同种类并成一条
  return [a.owner, a.type_key || '', a.level, a.bonus,
          a.module || '', a.side || '', a.status || ''].join('|');
}
function mergeArtifacts(d) {
  const arts = d.artifacts || [];
  const by = new Map();
  const out = [];
  for (const a of arts) {
    if (a.status === 'reserved') { out.push(a); continue; }   // 交易中的不合并，避免引用断掉
    const k = artKey(a);
    if (!k) { out.push(Object.assign({}, a, { qty: a.qty || 1 })); continue; }
    const hit = by.get(k);
    if (hit) { hit.qty = (hit.qty || 1) + (a.qty || 1); }
    else { const copy = Object.assign({}, a); copy.qty = a.qty || 1; by.set(k, copy); out.push(copy); }
  }
  d.artifacts = out;
}

async function mutate(fn, msg) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const f = await getFile('data.json');
    if (!f) throw new Error('仓库里没有 data.json');
    let data;
    try { data = JSON.parse(f.text); } catch (e) { throw new Error('data.json 解析失败'); }
    const out = fn(data);
    if (out === false) return null;
    mergeArtifacts(data);
    data.updated = Math.floor(Date.now() / 1000);
    const r = await fetch(API + '/contents/data.json', {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, H),
      body: JSON.stringify({
        message: msg || ('更新数据 ' + new Date().toISOString()),
        content: b64enc(JSON.stringify(data, null, 1)),
        sha: f.sha, branch: GH.branch
      })
    });
    if (r.ok) { return data; }
    const err = await r.json().catch(() => ({}));
    lastErr = new Error(err.message || ('写入失败 ' + r.status));
    if (r.status === 409 || r.status === 422) { await sleep(400 + i * 500); continue; }
    throw lastErr;
  }
  throw lastErr || new Error('写入冲突，请重试');
}

/* ---------------- 加载与渲染 ---------------- */
async function load() {
  const d = await readData();
  if (!d) { toast('数据加载失败，请刷新'); return; }
  S = Object.assign({ players: [], artifacts: [], needs: [], trades: [], notices: [], templates: {}, icons: {} }, d);
  $('#sTotal').textContent = S.artifacts.reduce((n, x) => n + (x.qty || 1), 0)
    + (S.artifacts.some(x => (x.qty || 1) > 1) ? `（${S.artifacts.length} 种）` : '');
  $('#sList').textContent = S.artifacts.filter(a => a.status === 'list').length;
  $('#sPlayers').textContent = S.players.length;
  const me = S.players.find(p => AUTH && p.id === AUTH.id);
  ME = me || null;
  if (!me && AUTH) { AUTH = null; localStorage.removeItem('qs_auth'); }
  $('#meName').textContent = me ? me.name : '未登录';
  $('#meHint').textContent = me ? ('账号 ' + (me.login || '—') + ' · 已登录') : '登录后才能上传、挂牌和发交换意向。';
  $('#authBtn').classList.toggle('hidden', !!me);
  $('#logoutBtn').classList.toggle('hidden', !me);
  renderIconPickers();
  if (typeof REC !== 'undefined') {
    const tpl = {};
    Object.entries(S.icons || {}).forEach(([id, ic]) => { if (ic && ic.sig) tpl[id] = { side: '', sigs: [ic.sig] }; });
    REC.setTemplates(tpl);
    if (!load.prewarmed) { load.prewarmed = true; REC.ensureWorker().catch(() => {}); }  // 提前下模型
  }
  fillSelects();
  renderMarket(); renderMatch(); renderInbox(); renderMine(); renderNotices();
}

let needIcon = '';

/* 量子技能筛选：下拉菜单，菜单项就是图标（按图标认，不用名字） */
function iconDDHTML(sel, labelAll) {
  const icons = Object.entries(S.icons || {});
  const cur = (sel && S.icons && S.icons[sel]) ? S.icons[sel] : null;
  const head = cur
    ? `${cur.thumb ? `<img src="${cur.thumb}">` : iconImg(sel, 22)}<span>已选：量子技能 ${cur.n ? '×' + cur.n : ''}</span>`
    : `<span>${labelAll}</span>`;
  const items = [`<button type="button" class="icondd-item ${sel ? '' : 'on'}" data-v=""><span>${labelAll}</span></button>`]
    .concat(icons.map(([id, ic]) => {
      const pic = ic && ic.thumb ? `<img src="${ic.thumb}">` : iconImg(id, 26);
      return `<button type="button" class="icondd-item ${sel === id ? 'on' : ''}" data-v="${id}">${pic}${ic && ic.n ? `<span>×${ic.n}</span>` : ''}</button>`;
    })).join('');
  return `<div class="icondd"><button type="button" class="icondd-btn">${head}<span class="caret">▾</span></button>
    <div class="icondd-panel">${items}</div></div>`;
}

function bindIconDD(el, cb) {
  if (!el) return;
  const panel = el.querySelector('.icondd-panel');
  el.querySelector('.icondd-btn').onclick = e => { e.stopPropagation(); panel.classList.toggle('open'); };
  el.querySelectorAll('.icondd-item').forEach(it => {
    it.onclick = e => { e.stopPropagation(); panel.classList.remove('open'); cb(it.dataset.v || ''); };
  });
}
document.addEventListener('click', () => document.querySelectorAll('.icondd-panel.open').forEach(p => p.classList.remove('open')));

function renderFilterIcons() {
  const f = $('#fModuleBar');
  if (f) { f.innerHTML = iconDDHTML(filterIcon, '全部量子技能'); bindIconDD(f, v => { filterIcon = v; renderFilterIcons(); renderMarket(); }); }
}

function renderIconPickers() {
  renderFilterIcons();
  const n = $('#nIconBar');
  if (n) { n.innerHTML = iconBarHTML(needIcon, '不限'); bindIconBar(n, v => { needIcon = v; }); }
  const cnt = $('#iconCount');
  if (cnt) cnt.textContent = Object.keys(S.icons || {}).length + ' 种图标';
}

function fillSelects() {
  if ($('#fType').options.length < 2) {
    $('#fType').innerHTML = ['<option value="">全部类型</option>'].concat(TYPES.map(t => `<option value="${t.key}">${t.name}</option>`)).join('');
  }
  const lvSel = $('#fLevel');
  if (lvSel) {
    const levels = new Set();
    (S.artifacts || []).forEach(a => { if (a.level != null) levels.add(a.level); });
    const cur = lvSel.value;
    lvSel.innerHTML = '<option value="">全部等级</option>' +
      [...levels].sort((x, y) => x - y).map(v => `<option value="${v}" ${cur === String(v) ? 'selected' : ''}>Lv${v}</option>`).join('');
  }
  if ($('#nType').options.length < 1) {
    $('#nType').innerHTML = TYPES.map(t => `<option value="${t.key}">${t.name}</option>`).join('');
  }
}

function hexSVG(color, level) {
  const dots = Math.max(4, Math.min(8, Math.round((level || 11) - 5)));
  let d = '';
  for (let i = 0; i < dots; i++) {
    const a = (i / dots) * Math.PI * 2 - Math.PI / 2;
    const x = 23 + Math.cos(a) * 14, y = 25 + Math.sin(a) * 14;
    d += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.1" fill="${color}" opacity=".92"/>`;
  }
  return `<svg viewBox="0 0 46 50">
    <polygon points="23,2 43,13 43,37 23,48 3,37 3,13" fill="${color}22" stroke="${color}" stroke-width="1.1" opacity=".8"/>
    <polygon points="23,9 37,17 37,33 23,41 9,33 9,17" fill="#0a1116" stroke="${color}66" stroke-width=".9"/>
    ${d}</svg>`;
}

function artCard(a, opts = {}) {
  const color = TYPE_COLOR[a.type_key] || '#8aa2b2';
  const lv = a.level ? `<span class="chip hi">Lv${a.level}</span>` : '';
  const bonus = a.bonus ? `<span class="chip hi">+${a.bonus}%</span>` : '';
  const mod = a.module ? iconChip(a.module) : '';
  const badgeElx = a.badge_img
    ? `<div class="badge ${a.side === '光' ? 'light' : ''}" style="overflow:hidden;padding:0"><img src="${a.badge_img}" style="width:100%;height:100%;object-fit:cover"></div>`
    : (a.module && iconOf(a.module) ? `<div class="badge ${a.side === '光' ? 'light' : ''}" style="overflow:hidden;padding:0">${iconImg(a.module, 34)}</div>` : '');
  const side = a.side ? `<span class="chip ${a.side === '暗' ? 'dark' : ''}">${a.side}</span>` : '';
  const qty = (a.qty || 1) > 1 ? `<span class="chip hi">×${a.qty}</span>` : '';
  const badgeEl = badgeElx;
  const cc = contactOf(a.owner);
  const ownerLine = opts.hideOwner ? '' : `<div class="owner">${playerName(a.owner)}${cc ? ` <span class="muted" style="font-size:11px">· ${cc}</span>` : ''}</div>`;
  return `<div class="art">
    <div class="hex">${hexSVG(color, a.level)}${badgeEl}</div>
    <div class="info">
      <div class="t1">${typeName(a.type_key)} ${lv}${bonus}${qty}${side}</div>
      <div class="t2">${mod || '无量子强化'}${a.status === 'reserved' ? ' · 交易中' : ''}</div>
      ${ownerLine}
    </div>
    <div class="row" style="flex:0 0 auto">${opts.actions || ''}</div>
  </div>`;
}

let filterIcon = '';
function renderMarket() {
  const t = $('#fType').value, m = filterIcon;
  const lv = $('#fLevel') ? $('#fLevel').value : '';
  const bnEl = $('#fBonus');
  const bn = bnEl && bnEl.value ? +bnEl.value : null;
  let list = S.artifacts.filter(a => a.status === 'list');
  if (t) list = list.filter(a => a.type_key === t);
  if (m) list = list.filter(a => a.module === m);
  if (lv) list = list.filter(a => a.level != null && a.level === +lv);
  if (bn != null) list = list.filter(a => a.bonus != null && a.bonus >= bn);
  $('#marketList').innerHTML = list.length
    ? list.sort((a, b) => (b.level || 0) - (a.level || 0)).map(a =>
      artCard(a, { actions: `<button class="btn mini" onclick="openTrade('${a.id}')">交换</button>` })).join('')
    : '<div class="empty">还没有可交换的神器，去「上传入库」把神器标记成「可交换」</div>';
}

/* 匹配算法（与本地版一致） */
function matchScore(a, n) {
  let s = 60;
  if (n.type_key && a.type_key !== n.type_key) return 0;
  if (n.module && a.module !== n.module) return 0;
  if (n.side && a.side !== n.side) return 0;
  if (n.min_level && (a.level || 0) < n.min_level) return 0;
  if (n.min_bonus && (a.bonus || 0) < n.min_bonus) return 0;
  if (a.module) s += 12;
  if (a.level && a.level >= 11) s += 8;
  if (a.bonus && a.bonus >= 360) s += 10;
  if (n.min_bonus && a.bonus) s += 5;
  return Math.min(s, 100);
}

function renderMatch() {
  if (!ME) { $('#wantList').innerHTML = '<div class="empty">先登录</div>'; $('#offerList').innerHTML = ''; return; }
  const needs = S.needs.filter(n => n.status === 'open');
  const arts = S.artifacts.filter(a => a.status === 'list');
  const want = [], offer = [];
  needs.filter(n => n.player === ME.id).forEach(n => arts.forEach(a => {
    if (a.owner === ME.id) return;
    const sc = matchScore(a, n);
    if (sc) want.push({ a, n, sc, owner: playerName(a.owner) });
  }));
  arts.filter(a => a.owner === ME.id).forEach(a => needs.forEach(n => {
    if (n.player === ME.id) return;
    const sc = matchScore(a, n);
    if (sc) offer.push({ a, n, sc, owner: playerName(n.player) });
  }));
  want.sort((x, y) => y.sc - x.sc); offer.sort((x, y) => y.sc - x.sc);
  $('#wantList').innerHTML = want.length ? want.map(x => `
    <div class="tcard">
      <div class="lenflex"><span class="muted">需求：${needLabel(x.n)}</span><span class="pill">匹配 ${x.sc}</span></div>
      ${artCard(x.a, { actions: `<button class="btn mini" onclick="openTrade('${x.a.id}')">交换</button>` })}
    </div>`).join('') : '<div class="empty">暂无匹配：给自己发布一条需求试试</div>';
  $('#offerList').innerHTML = offer.length ? offer.map(x => `
    <div class="tcard">
      <div class="lenflex"><span class="muted">${x.owner} 想要：${needLabel(x.n)}</span><span class="pill">匹配 ${x.sc}</span></div>
      ${artCard(x.a, { hideOwner: true })}
    </div>`).join('') : '<div class="empty">暂无：把神器标成「可交换」，或等别人发需求</div>';
}

function tradeRow(t, mine) {
  const a = S.artifacts.find(x => x.id === t.aid);
  const label = { pending: '待确认', accepted: '已接受·待成交', declined: '已拒绝', done: '已完成' }[t.status] || t.status;
  const acts = mine
    ? (t.status === 'pending' ? `<button class="btn mini" onclick="act('${t.id}','accept')">接受</button><button class="btn ghost mini" onclick="act('${t.id}','decline')">拒绝</button>` : '')
    + (t.status === 'accepted' ? `<button class="btn mini" onclick="act('${t.id}','done')">标记成交</button>` : '')
    : (t.status === 'pending' ? `<button class="btn ghost mini" onclick="act('${t.id}','decline')">撤回</button>` : '');
  return `<div class="tcard">
    <div class="lenflex"><span class="muted">${mine ? ('来自 ' + playerName(t.from)) : ('发给 ' + playerName(t.to))} · ${label}</span>
      <span class="pill">${new Date(t.t * 1000).toLocaleDateString('zh-CN')}</span></div>
    ${a ? artCard(a) : '<div class="muted">神器已删除</div>'}
    ${t.give && S.artifacts.find(x => x.id === t.give) ? `<div class="muted" style="margin-top:4px">对方拿：${artCard(S.artifacts.find(x => x.id === t.give), { hideOwner: true })}</div>` : ''}
    ${t.msg ? `<div class="muted" style="margin-top:6px">留言：${t.msg}</div>` : ''}
    <div class="row" style="margin-top:8px;justify-content:flex-end">${acts}</div>
  </div>`;
}

function renderInbox() {
  if (!ME) { $('#inList').innerHTML = $('#outList').innerHTML = '<div class="empty">先登录</div>'; return; }
  const inc = S.trades.filter(t => t.to === ME.id).reverse();
  const out = S.trades.filter(t => t.from === ME.id).reverse();
  $('#inList').innerHTML = inc.length ? inc.map(t => tradeRow(t, true)).join('') : '<div class="empty">还没有人向你发起交换</div>';
  $('#outList').innerHTML = out.length ? out.map(t => tradeRow(t, false)).join('') : '<div class="empty">你还没发起过交换</div>';
}

function renderMine() {
  if (!ME) { $('#mineList').innerHTML = $('#myNeedList').innerHTML = '<div class="empty">先登录</div>'; return; }
  const c = playerOf(ME.id).contact || {};
  if ($('#cQQ')) {
    if (document.activeElement !== $('#cQQ')) $('#cQQ').value = c.qq || '';
    if (document.activeElement !== $('#cDiscord')) $('#cDiscord').value = c.discord || '';
    if (document.activeElement !== $('#cCorp')) $('#cCorp').value = c.corp || '';
    $('#cHint').textContent = contactOf(ME.id) ? '已保存：' + contactOf(ME.id) : '还没填联系方式';
  }
  const arts = S.artifacts.filter(a => a.owner === ME.id);
  $('#mineList').innerHTML = arts.length ? arts.map(a => artCard(a, {
    hideOwner: true, actions: `
      <select onchange="setStatus('${a.id}',this.value)" style="width:auto;padding:5px 8px;font-size:12px">
        <option value="list" ${a.status !== 'have' ? 'selected' : ''}>可交换</option>
        <option value="have" ${a.status === 'have' ? 'selected' : ''}>下架</option>
        <option value="reserved" ${a.status === 'reserved' ? 'selected' : ''} disabled>交易中</option>
      </select>
      <button class="btn ghost mini" onclick="openEdit('${a.id}')">改</button>
      <button class="btn ghost mini" onclick="delArt('${a.id}')">删</button>`
  })).join('') : '<div class="empty">还没有神器，去「上传入库」</div>';
  const needs = S.needs.filter(n => n.player === ME.id && n.status === 'open');
  $('#myNeedList').innerHTML = needs.length ? needs.map(n => `
    <div class="tcard"><div class="lenflex">
      <span>${needLabel(n)}</span>
      <button class="btn ghost mini" onclick="delNeed('${n.id}')">删除</button></div>
      ${n.note ? `<div class="muted" style="margin-top:4px">${n.note}</div>` : ''}</div>`).join('')
    : '<div class="empty">还没有需求，上面发布一条</div>';
}

async function saveContact() {
  if (!ME) { toast('请先登录'); openAuth(); return; }
  const contact = {
    qq: ($('#cQQ').value || '').trim(),
    discord: ($('#cDiscord').value || '').trim(),
    corp: ($('#cCorp').value || '').trim()
  };
  await mutate(d => {
    d.players = d.players || [];
    let p = d.players.find(x => x.id === ME.id);
    if (!p) { p = { id: ME.id, name: ME.name, note: '' }; d.players.push(p); }
    p.contact = contact;
  }, '更新联系方式');
  toast('联系方式已保存');
  await load();
}

function renderNotices() {
  const list = (S.notices || []).slice(-8).reverse();
  $('#notices').innerHTML = list.length ? list.map(n => `
    <div class="tcard"><div class="lenflex">
      <span class="muted">${n.player || ''} · ${new Date(n.t * 1000).toLocaleString('zh-CN', { hour12: false })}</span>
    </div><div style="font-size:13px">${n.note}</div></div>`).join('')
    : '<div class="empty">还没有记录</div>';
}

/* ---------------- AI 识别（上传到仓库 inbox，Actions 里跑深度学习 OCR） ---------------- */
let pendingSlots = [], pendingBadges = [];
const aiState = { busy: false, baseline: 0, baselineN: 0, head: '' };

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* 上传前压成 JPEG：分辨率不变（小字号还读得出来），体积降到 1/3~1/5，上传快很多 */
function fileToJpegB64(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      res(String(c.toDataURL('image/jpeg', 0.95)).split(',')[1] || '');
    };
    img.onerror = e => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

async function ghJson(path, opts = {}) {
  const r = await fetch(API + path, Object.assign({ headers: Object.assign({ 'Content-Type': 'application/json' }, H) }, opts));
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

/* 一次性把整批图 commit 进去：只触发一个 Actions，比一张一提交快好几倍 */
async function putFilesBatch(files, message) {
  const ref = await ghJson('/git/ref/heads/' + GH.branch);
  const baseSha = ref.object.sha;
  const baseCommit = await ghJson('/git/commits/' + baseSha);
  const blobs = [];
  for (const f of files) {
    const b = await ghJson('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.b64, encoding: 'base64' }) });
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
  }
  const tree = await ghJson('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: blobs }) });
  const commit = await ghJson('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [baseSha] }) });
  const up = await ghJson('/git/refs/heads/' + GH.branch, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return up;
}

$('#pickBtn').onclick = () => $('#file').click();

/* ---------------- 本地 AI 识别（浏览器内跑 PP-OCRv4，秒级、分辨率无关） ---------------- */
async function aiLocalRecognize(files) {
  const all = [];
  await AIOCR.load((msg, got, total) => {
    const pct = total ? Math.min(99, Math.floor(got * 100 / total)) : 0;
    $('#upHint').textContent = `${msg} ${pct}%（首次一次，之后走缓存）`;
  });
  for (let i = 0; i < files.length; i++) {
    $('#upHint').textContent = `AI 识别中 ${i + 1}/${files.length}…`;
    const items = await AIOCR.recognizeFile(files[i], msg => { $('#upHint').textContent = `${msg} ${i + 1}/${files.length}`; });
    for (const it of items) all.push(it);
  }
  return all;
}

async function commitItems(items) {
  if (!ME) { toast('请先登录'); openAuth(); return null; }
  const base = Date.now().toString(36);
  const rows = items.map((s, i) => ({
    id: 'a' + base + i + Math.floor(Math.random() * 1e4).toString(36),
    owner: ME.id, type_key: s.type_key || '', level: s.level, bonus: s.bonus,
    module: '', side: s.side || '', status: s.status || 'list',
    note: '', img: s.plate || '', badge_img: s.badge_img || '', sig: s.sig || '',
    lum: s.lum == null ? null : s.lum, qty: 1,
    t: Math.floor(Date.now() / 1000)
  }));
  let added = 0;
  await mutate(d => {
    d.artifacts = d.artifacts || [];
    for (const it of rows) it.module = it.sig ? ensureIcon(d, it.sig, it.badge_img, it.lum, it.type_key) : '';
    for (const it of rows) {
      const same = d.artifacts.find(a => artKey(a) === artKey(it) && a.status !== 'reserved');
      if (same) same.qty = (same.qty || 1) + 1;
      else { d.artifacts.push(it); added++; }
    }
    d.notices = (d.notices || []).concat([{
      t: Math.floor(Date.now() / 1000), player: ME.name, img: '',
      note: `AI 识别入库 ${rows.length} 件（同款已合并）`
    }]).slice(-30);
  }, `入库 ${rows.length} 件神器`);
  return { total: rows.length, added };
}

/* 云端 AI 识别主路径：图传进 inbox（一次 commit 触发一次 Actions），
   云端跑完把结果写成 inbox_out/<batch>.json，这里取回来做成核对卡片，你确认后才入库 */
/* 图片走 raw.githubusercontent：云端一提交就立即可读；Pages 要等 1~2 分钟重新构建，会先 404 出“图片出不来” */
const IMG_BASE = RAW;

async function pollResult(batch, t0) {
  let tries = 0;
  while (tries++ < 150) {                      // 每秒一滴答，最多约 2.5 分钟
    await new Promise(r => setTimeout(r, 1000));
    const secs = Math.round((performance.now() - t0) / 1000);
    const left = Math.max(0, 40 - secs);
    $('#upHint').textContent = left
      ? `云端 AI 识别中… 倒计时 ${left}s（已用 ${secs}s）`
      : `云端 AI 识别中… 已用 ${secs}s，快好了`;
    try {
      const f = await getFile('inbox_out/' + batch + '.json');
      if (f && f.text) return JSON.parse(f.text);
    } catch (e) { }
  }
  throw new Error('云端识别超时，稍后刷新试试');
}

async function cloudRecognize(files) {
  const t0 = performance.now();
  const head = b64url(ME.name);
  const ts = Math.floor(Date.now() / 1000);
  const batch = `${head}__${ts}`;
  const up = [];
  for (let i = 0; i < files.length; i++) {
    $('#upHint').textContent = `正在上传 ${i + 1}/${files.length} 张…`;
    up.push({ path: `inbox/${batch}_${i}.jpg`, b64: await fileToJpegB64(files[i]) });
  }
  $('#upHint').textContent = '上传完成，开始识别… 倒计时 40s';
  await putFilesBatch(up, `AI 识别上传 ${ME.name}（${files.length} 张）`);
  $('#file').value = '';
  const res = await pollResult(batch, t0);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  // 认不全也留行：宁可空着让你手填，也别默默少一行
  const items = (res.items || []).filter(it => it.level != null || it.bonus != null || it.plate)
    .map(it => ({
      type_key: it.type_key || null, level: it.level == null ? null : it.level, bonus: it.bonus == null ? null : it.bonus, side: it.side || '暗',
      sig: it.sig || '', lum: it.lum == null ? null : it.lum,
      plate: it.plate ? IMG_BASE + it.plate : '', badge_img: it.badge_img ? IMG_BASE + it.badge_img : '',
      badge_present: !!(it.badge_img || it.sig), module: it.module || ''
    }));
  if (!items.length) throw new Error('云端没认出神器');
  return { items, secs };
}

$('#file').onchange = async e => {
  const files = Array.from($('#file').files || []);
  if (!files.length) return;
  if (!ME) { toast('请先登录'); openAuth(); return; }
  if (aiState.busy) { toast('上一批还在识别，稍等一下'); return; }
  aiState.busy = true;
  $('#resultCard').classList.add('hidden');
  $('#upHint').textContent = '准备上传…';
  try {
    const r = await cloudRecognize(files);
    pendingSlots = r.items.map(s => Object.assign({ status: 'list' }, s));
    const grid = r.items.some(s => !s.type_key);
    $('#resHint').textContent = `云端 AI 认出 ${r.items.length} 件（${r.secs}s）。` +
      (grid ? '容器截图没有类型文字，在上面选一次类型；' : '') + '核对无误就点「确认入库」。';
    renderResult();
    $('#upHint').textContent = '';
  } catch (err) {
    console.warn('云端失败，转本地识别', err);
    try {
      $('#upHint').textContent = '云端没成功，改用本地识别…';
      const items = await aiLocalRecognize(files);
      $('#file').value = '';
      if (!items.length) throw new Error('没认到神器，换张图试试');
      pendingSlots = items.map(s => Object.assign({ status: 'list', side: s.side || '暗' }, s));
      $('#resHint').textContent = `本地认出 ${items.length} 件。核对无误就点「确认入库」。`;
      renderResult();
      $('#upHint').textContent = '';
    } catch (e2) {
      $('#upHint').textContent = '';
      $('#file').value = '';
      toast('识别失败：' + e2.message);
    }
  } finally {
    aiState.busy = false;
  }
};

function clearResult() { pendingSlots = []; $('#resultCard').classList.add('hidden'); $('#file').value = ''; }

function renderResult() {
  $('#resultCard').classList.remove('hidden');
  $('#resCount').textContent = `共 ${pendingSlots.length} 件`;
  const noType = pendingSlots.filter(s => !s.type_key);
  const batchBar = noType.length ? `
    <div class="row" style="margin-bottom:10px;align-items:center;gap:8px">
      <span class="muted" style="font-size:12px">${noType.length} 件没认出类型（容器截图没有类型文字）</span>
      <select id="batchType" style="max-width:140px"><option value="">选类型…</option>${TYPES.map(t => `<option value="${t.key}">${t.name}</option>`).join('')}</select>
      <button class="btn ghost mini" id="batchApply">一次填好</button>
    </div>` : '';
  $('#resHint').textContent = noType.length ? '等级/加成已认出；类型请在上面一次选好，再入库。' : '核对无误就点「确认入库」。';
  const tOpts = k => ['<option value="">未知</option>'].concat(
    TYPES.map(t => `<option value="${t.key}" ${t.key === k ? 'selected' : ''}>${t.name}</option>`)).join('');
  $('#resGrid').innerHTML = batchBar + pendingSlots.map((s, i) => `
    <div class="slot">
      ${s.plate ? `<img class="plate" src="${s.plate}">` : '<div class="empty">无图</div>'}
      <label class="f">类型</label><select data-i="${i}" data-k="type_key">${tOpts(s.type_key)}</select>
      <div class="grid2" style="margin-top:4px">
        <div><label class="f">等级</label><input data-i="${i}" data-k="level" type="number" value="${s.level == null ? '' : s.level}"></div>
        <div><label class="f">加成%</label><input data-i="${i}" data-k="bonus" type="number" value="${s.bonus == null ? '' : s.bonus}"></div>
      </div>
      <label class="f">量子强化${s.badge_present ? (s.module ? '（同款）' : '（新）') : '（无）'}</label>
      <div class="iconcell">${s.badge_present && s.badge_img ? `<img src="${s.badge_img}">` : '<span class="muted" style="font-size:12px">无</span>'}</div>
      <div class="grid2" style="margin-top:4px">
        <div><label class="f">光/暗</label><select data-i="${i}" data-k="side">
          <option value="" ${!s.side ? 'selected' : ''}>—</option>
          <option ${s.side === '光' ? 'selected' : ''}>光</option><option ${s.side === '暗' ? 'selected' : ''}>暗</option></select></div>
        <div><label class="f">状态</label><select data-i="${i}" data-k="status">
          <option value="list" ${s.status !== 'have' ? 'selected' : ''}>可交换（默认）</option>
          <option value="have" ${s.status === 'have' ? 'selected' : ''}>下架</option></select></div>
      </div>
    </div>`).join('');
  const ba = $('#batchApply');
  if (ba) ba.onclick = () => {
    const v = $('#batchType').value;
    if (!v) { toast('先选一个类型'); return; }
    pendingSlots.forEach(x => { if (!x.type_key) x.type_key = v; });
    renderResult();
  };
  $('#resGrid').querySelectorAll('select[data-k],input[data-k]').forEach(el => {
    el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k;
      pendingSlots[i][k] = (k === 'level' || k === 'bonus') ? (el.value ? +el.value : null) : el.value;
    };
  });
}

$('#commitBtn').onclick = async () => {
  if (!ME) { toast('请先登录'); openAuth(); return; }
  if (!pendingSlots.length) return;
  $('#commitBtn').disabled = true;
  try {
    const items = pendingSlots.map((s, i) => ({
      id: 'a' + Date.now().toString(36) + i,
      owner: ME.id, type_key: s.type_key || '', level: s.level, bonus: s.bonus,
      module: s.module || '', side: s.side || '', status: s.status || 'list',
      note: '', img: '', badge_img: s.badge_img || '', sig: s.sig || '', qty: 1,
      t: Math.floor(Date.now() / 1000)
    }));
    let added = 0;
    await mutate(d => {
      d.artifacts = d.artifacts || [];
      for (const it of items) it.module = it.sig ? ensureIcon(d, it.sig, it.badge_img, it.lum, it.type_key) : '';
      for (const it of items) {
        const same = d.artifacts.find(a => artKey(a) === artKey(it) && a.status !== 'reserved');
        if (same) same.qty = (same.qty || 1) + 1;      // 同款：只加数量
        else { d.artifacts.push(it); added++; }
      }
      d.notices = (d.notices || []).concat([{
        t: Math.floor(Date.now() / 1000), player: ME.name, img: '',
        note: `识别入库 ${items.length} 件（同款已合并）`
      }]).slice(-30);
    }, `入库 ${items.length} 件神器`);
    toast(`已入库 ${items.length} 件${added < items.length ? `，合并为 ${added} 条` : ''}`);
    clearResult();
    await load();
    switchTab('mine');
  } catch (e) {
    toast('入库失败：' + e.message);
  } finally {
    $('#commitBtn').disabled = false;
  }
};

/* 手动添加一件 */
async function addManual() {
  if (!ME) { toast('请先登录'); openAuth(); return; }
  const rec = {
    id: 'a' + Date.now().toString(36), owner: ME.id, type_key: 'trade', level: null, bonus: null,
    module: '', side: '', status: 'list', note: '', img: '', badge_img: '', sig: '',
    t: Math.floor(Date.now() / 1000)
  };
  try {
    await mutate(d => { d.artifacts = (d.artifacts || []).concat([rec]); }, '手动添加神器');
    await load();
    openEdit(rec.id);
  } catch (e) { toast('添加失败：' + e.message); }
}

/* ---------------- 神器编辑 ---------------- */
async function setStatus(id, v) {
  try {
    await mutate(d => { const a = d.artifacts.find(x => x.id === id); if (a) a.status = v; }, '切换神器状态');
    await load();
  } catch (e) { toast('失败：' + e.message); }
}

async function delArt(id) {
  if (!confirm('删除这件神器记录？')) return;
  try {
    await mutate(d => { d.artifacts = d.artifacts.filter(a => a.id !== id); }, '删除神器');
    await load();
  } catch (e) { toast('失败：' + e.message); }
}

async function delNeed(id) {
  try {
    await mutate(d => { d.needs = d.needs.filter(n => n.id !== id); }, '删除需求');
    await load();
  } catch (e) { toast('失败：' + e.message); }
}

function openEdit(id) {
  editing = Object.assign({}, S.artifacts.find(a => a.id === id));
  if (!editing) return;
  $('#eType').innerHTML = TYPES.map(t => `<option value="${t.key}" ${t.key === editing.type_key ? 'selected' : ''}>${t.name}</option>`).join('');
  $('#eIcon').innerHTML = editing.module
    ? `${iconImg(editing.module, 40)} <button class="btn ghost mini" id="eIconClear">清除图标</button>`
    : `<span class="muted" style="font-size:12px">无量子强化</span>`;
  if ($('#eIconClear')) $('#eIconClear').onclick = () => { editing._clearIcon = true; $('#eIcon').innerHTML = '<span class="muted" style="font-size:12px">提交后清除</span>'; };
  $('#eSide').value = editing.side || '';
  $('#eLevel').value = editing.level || '';
  $('#eBonus').value = editing.bonus || '';
  $('#eSave').onclick = saveEdit;
  $('#dlgEdit').showModal();
}

async function saveEdit() {
  const a = editing;
  const patch = {
    type_key: $('#eType').value, module: editing._clearIcon ? '' : (editing.module || ''), side: $('#eSide').value,
    level: $('#eLevel').value ? +$('#eLevel').value : null,
    bonus: $('#eBonus').value ? +$('#eBonus').value : null
  };
  try {
    await mutate(d => {
      const x = d.artifacts.find(y => y.id === a.id);
      if (!x) return false;
      Object.assign(x, patch);
      if (!patch.module && x.sig && d.icons) {
        // 清除图标时把它从图标库减一个计数（不删库，避免误伤别人同款）
        for (const ic of Object.values(d.icons)) { if (ic.sig === x.sig && ic.n > 0) ic.n--; }
      }
    }, '修正神器 ' + a.id);
    $('#dlgEdit').close();
    toast('已保存');
    await load();
  } catch (e) { toast('保存失败：' + e.message); }
}

/* ---------------- 需求 ---------------- */
async function postNeed() {
  if (!ME) { toast('请先登录'); openAuth(); return; }
  const body = {
    type_key: $('#nType').value, module: needIcon, side: $('#nSide').value,
    min_level: +$('#nLv').value || 0, min_bonus: +$('#nBonus').value || 0, note: $('#nNote').value
  };
  try {
    await mutate(d => {
      d.needs = d.needs || [];
      d.needs.push(Object.assign({
        id: 'n' + Date.now().toString(36), player: ME.id, status: 'open'
      }, body));
    }, '发布需求');
    $('#nNote').value = '';
    toast('需求已发布');
    await load();
  } catch (e) { toast('发布失败：' + e.message); }
}

/* ---------------- 交换意向 ---------------- */
function openTrade(aid) {
  if (!ME) { toast('请先登录'); openAuth(); return; }
  dlgArtifact = S.artifacts.find(a => a.id === aid);
  if (!dlgArtifact) return;
  if (dlgArtifact.owner === ME.id) { toast('这是你自己的神器'); return; }
  $('#dlgTarget').innerHTML = `${typeName(dlgArtifact.type_key)} ${dlgArtifact.level ? 'Lv' + dlgArtifact.level : ''} ${dlgArtifact.bonus ? '+' + dlgArtifact.bonus + '%' : ''}
    ${dlgArtifact.module ? iconChip(dlgArtifact.module) : ''} ${dlgArtifact.side || ''} · 持有者 ${playerName(dlgArtifact.owner)}${contactOf(dlgArtifact.owner) ? `<div class="muted" style="margin-top:4px">联系：${contactOf(dlgArtifact.owner)}</div>` : '<div class="muted" style="margin-top:4px">对方还没填联系方式</div>'}`;
  const mine = S.artifacts.filter(a => a.owner === ME.id && a.status !== 'reserved');
  $('#dlgGive').innerHTML = '<option value="">不指定</option>'
    + mine.map(a => `<option value="${a.id}">${typeName(a.type_key)} ${a.level ? 'Lv' + a.level : ''} ${a.bonus ? '+' + a.bonus + '%' : ''} ${a.module ? '[有量子强化] ' : ''}${a.side || ''}${(a.qty || 1) > 1 ? ' ×' + a.qty : ''}</option>`).join('');
  $('#dlgMsg').value = '';
  $('#dlgSend').onclick = async () => {
    const give = $('#dlgGive').value || null;
    try {
      await mutate(d => {
        d.trades = d.trades || [];
        d.trades.push({
          id: 't' + Date.now().toString(36), aid: aid, from: ME.id, to: dlgArtifact.owner,
          give: give, need: null, msg: $('#dlgMsg').value, status: 'pending', t: Math.floor(Date.now() / 1000)
        });
      }, '发起交换意向');
      $('#dlgTrade').close();
      toast('意向已发送');
      await load();
    } catch (e) { toast('发送失败：' + e.message); }
  };
  $('#dlgTrade').showModal();
}

async function act(id, action) {
  try {
    await mutate(d => {
      const t = (d.trades || []).find(x => x.id === id);
      if (!t) return false;
      const art = d.artifacts.find(a => a.id === t.aid);
      if (action === 'accept') { t.status = 'accepted'; if (art) art.status = 'reserved'; }
      if (action === 'decline') { t.status = 'declined'; if (art && art.status === 'reserved') art.status = 'list'; }
      if (action === 'done') {
        t.status = 'done';
        if (art) { art.owner = t.from; art.status = 'have'; }
        if (t.give) {
          const g = d.artifacts.find(a => a.id === t.give);
          if (g) {
            if ((g.qty || 1) > 1) g.qty--;              // 同款还有多的，只走一件
            else { g.owner = t.to; g.status = 'have'; }
          }
        }
        (d.needs || []).forEach(n => { if (n.player === t.from && n.status === 'open' && !n.type_key) n.status = 'closed'; });
      }
      t.u = Math.floor(Date.now() / 1000);
    }, '交换操作 ' + action);
    toast({ accept: '已接受，等双方上线交易', decline: '已拒绝', done: '已成交，记录已转移' }[action] || '完成');
    await load();
  } catch (e) { toast('操作失败：' + e.message); }
}

/* ---------------- 账号：注册 / 登录 ---------------- */
const AUTH_KEY = 'qs_auth';
let authModeNow = 'login';

function randHex(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function hashPw(pw, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 60000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fail(e) { toast(e.message || String(e)); }

function openAuth(mode) {
  authModeNow = mode || 'login';
  authMode(authModeNow);
  $('#lLogin').value = ''; $('#lPw').value = '';
  $('#rName').value = ''; $('#rLogin').value = ''; $('#rPw').value = ''; $('#rPw2').value = '';
  $('#dlgAuth').showModal();
}

function authMode(m) {
  authModeNow = m;
  const isLogin = m === 'login';
  $('#loginBox').classList.toggle('hidden', !isLogin);
  $('#regBox').classList.toggle('hidden', isLogin);
  $('#tabLogin').className = (isLogin ? 'btn' : 'btn ghost') + ' mini';
  $('#tabReg').className = (isLogin ? 'btn ghost' : 'btn') + ' mini';
  $('#authTitle').textContent = isLogin ? '登录' : '注册新成员';
  $('#authGo').textContent = isLogin ? '登录' : '注册并登录';
}

async function doLogin() {
  const login = ($('#lLogin').value || '').trim().toLowerCase();
  const pw = $('#lPw').value;
  if (!login || !pw) { toast('账号和密码都要填'); return; }
  $('#authGo').disabled = true;
  try {
    const d = await readData();
    const p = (d.players || []).find(x => (x.login || '').toLowerCase() === login);
    if (!p || !p.pw) { toast('账号不存在，或还没注册'); return; }
    const h = await hashPw(pw, p.salt || '');
    if (h !== p.pw) { toast('密码不对'); return; }
    AUTH = { id: p.id, login: p.login, name: p.name };
    localStorage.setItem(AUTH_KEY, JSON.stringify(AUTH));
    $('#dlgAuth').close();
    toast('欢迎回来，' + p.name);
    await load();
  } catch (e) { fail(e); } finally { $('#authGo').disabled = false; }
}

async function doReg() {
  const name = ($('#rName').value || '').trim();
  const login = ($('#rLogin').value || '').trim().toLowerCase();
  const pw = $('#rPw').value;
  const pw2 = $('#rPw2').value;
  if (!name) { toast('请填游戏名'); return; }
  if (!/^[a-z0-9_.-]{3,20}$/.test(login)) { toast('账号要 3–20 位字母数字'); return; }
  if (pw.length < 6) { toast('密码至少 6 位'); return; }
  if (pw !== pw2) { toast('两次密码不一致'); return; }
  $('#authGo').disabled = true;
  try {
    const salt = randHex(8);
    const pwHash = await hashPw(pw, salt);
    let result = null;
    await mutate(d => {
      d.players = d.players || [];
      if (d.players.some(x => (x.login || '').toLowerCase() === login))
        throw new Error('这个账号已被占用');
      const same = d.players.find(x => x.name === name);
      if (same && same.pw) throw new Error('游戏名「' + name + '」已被别人注册');
      if (same) {  // 认领名单里已有、还没设账号的成员
        Object.assign(same, { login: login, salt: salt, pw: pwHash, claimed: 1 });
        result = same;
        return;
      }
      const np = {
        id: 'p' + Date.now().toString(36), name: name, login: login, salt: salt, pw: pwHash, note: ''
      };
      d.players.push(np);
      result = np;
    }, '注册成员 ' + name);
    if (!result) { toast('注册失败，请重试'); return; }
    AUTH = { id: result.id, login: result.login, name: result.name };
    localStorage.setItem(AUTH_KEY, JSON.stringify(AUTH));
    $('#dlgAuth').close();
    toast('注册成功，' + result.name + (result.claimed ? '（已认领原有神器）' : ''));
    await load();
  } catch (e) { fail(e); } finally { $('#authGo').disabled = false; }
}

$('#authGo').onclick = () => (authModeNow === 'login' ? doLogin() : doReg());
$('#tabLogin').onclick = () => authMode('login');
$('#tabReg').onclick = () => authMode('reg');

function logout() {
  AUTH = null; ME = null;
  localStorage.removeItem(AUTH_KEY);
  toast('已退出');
  load();
}

/* ---------------- tabs ---------------- */
function switchTab(v) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('hidden', x.id !== 'v-' + v));
  if (v === 'match') renderMatch();
}
$('#tabs').onclick = e => { const t = e.target.closest('.tab'); if (t) switchTab(t.dataset.v); };
['#fType'].forEach(s => document.addEventListener('change', e => { if (e.target.matches(s)) renderMarket(); }));
['#fLevel', '#fBonus'].forEach(s => document.addEventListener(s === '#fBonus' ? 'input' : 'change', e => { if (e.target.matches(s)) renderMarket(); }));

load();
