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
const MODULES = [
  ['tradeburst', '贸易爆发'], ['crunch', '矿物粉碎'], ['hydro', '氢气火箭'],
  ['fortify', '固若金汤'], ['delta', '德尔塔火箭'], ['laser', '激光武器'],
  ['bomber', '火箭发射器'], ['shields', '奥米加护盾'], ['alpha', '火箭无人机'],
  ['cerb', '地狱犬无人机']
];
const TYPE_COLOR = Object.fromEntries(TYPES.map(t => [t.key, t.color]));

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let S = { players: [], artifacts: [], needs: [], trades: [], notices: [], templates: {} };
let AUTH = JSON.parse(localStorage.getItem('qs_auth') || 'null');
let ME = null;
let dlgArtifact = null, editing = null, polling = false;

function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); setTimeout(() => e.classList.remove('on'), 2200); }
const typeName = k => (TYPES.find(t => t.key === k) || {}).name || '未知';
const moduleName = k => (MODULES.find(m => m[0] === k) || [])[1] || '';
const playerName = id => (S.players.find(p => p.id === id) || {}).name || '?';

function needLabel(n) {
  const t = n.type_key ? typeName(n.type_key) : '任意类型';
  const m = n.module ? (' · ' + moduleName(n.module)) : '';
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
async function mutate(fn, msg) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const f = await getFile('data.json');
    if (!f) throw new Error('仓库里没有 data.json');
    let data;
    try { data = JSON.parse(f.text); } catch (e) { throw new Error('data.json 解析失败'); }
    const out = fn(data);
    if (out === false) return null;
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
  S = Object.assign({ players: [], artifacts: [], needs: [], trades: [], notices: [], templates: {} }, d);
  $('#sTotal').textContent = S.artifacts.length;
  $('#sList').textContent = S.artifacts.filter(a => a.status === 'list').length;
  $('#sPlayers').textContent = S.players.length;
  const me = S.players.find(p => AUTH && p.id === AUTH.id);
  ME = me || null;
  if (!me && AUTH) { AUTH = null; localStorage.removeItem('qs_auth'); }
  $('#meName').textContent = me ? me.name : '未登录';
  $('#meHint').textContent = me ? ('账号 ' + (me.login || '—') + ' · 已登录') : '登录后才能上传、挂牌和发交换意向。';
  $('#authBtn').classList.toggle('hidden', !!me);
  $('#logoutBtn').classList.toggle('hidden', !me);
  if (typeof REC !== 'undefined') REC.setTemplates(S.templates || {});
  fillSelects();
  renderMarket(); renderMatch(); renderInbox(); renderMine(); renderNotices();
}

function fillSelects() {
  if ($('#fType').options.length < 2) {
    $('#fType').innerHTML = ['<option value="">全部类型</option>'].concat(TYPES.map(t => `<option value="${t.key}">${t.name}</option>`)).join('');
    $('#fModule').innerHTML = ['<option value="">全部模块</option>'].concat(MODULES.map(m => `<option value="${m[0]}">${m[1]}</option>`)).join('');
  }
  if ($('#nType').options.length < 1) {
    $('#nType').innerHTML = TYPES.map(t => `<option value="${t.key}">${t.name}</option>`).join('');
    $('#nModule').innerHTML = ['<option value="">不限</option>'].concat(MODULES.map(m => `<option value="${m[0]}">${m[1]}</option>`)).join('');
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
  const mod = a.module ? `<span class="chip">${moduleName(a.module)}</span>`
    : (a.side ? '<span class="chip">模块待确认</span>' : '');
  const side = a.side ? `<span class="chip ${a.side === '暗' ? 'dark' : ''}">${a.side}</span>` : '';
  const badgeEl = a.badge_img
    ? `<div class="badge ${a.side === '光' ? 'light' : ''}" style="overflow:hidden;padding:0"><img src="${a.badge_img}" style="width:100%;height:100%;object-fit:cover"></div>`
    : (a.side ? `<div class="badge ${a.side === '光' ? 'light' : ''}">${(moduleName(a.module) || '?').slice(0, 1)}</div>` : '');
  const ownerLine = opts.hideOwner ? '' : `<div class="owner">${playerName(a.owner)}</div>`;
  return `<div class="art">
    <div class="hex">${hexSVG(color, a.level)}${badgeEl}</div>
    <div class="info">
      <div class="t1">${typeName(a.type_key)} ${lv}${bonus}${side}</div>
      <div class="t2">${mod || '无量子模块'}${a.status === 'reserved' ? ' · 交易中' : ''}</div>
      ${ownerLine}
    </div>
    <div class="row" style="flex:0 0 auto">${opts.actions || ''}</div>
  </div>`;
}

function renderMarket() {
  const t = $('#fType').value, m = $('#fModule').value, sd = $('#fSide').value;
  let list = S.artifacts.filter(a => a.status === 'list');
  if (t) list = list.filter(a => a.type_key === t);
  if (m) list = list.filter(a => a.module === m);
  if (sd) list = list.filter(a => a.side === sd);
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
  const arts = S.artifacts.filter(a => a.owner === ME.id);
  $('#mineList').innerHTML = arts.length ? arts.map(a => artCard(a, {
    hideOwner: true, actions: `
      <select onchange="setStatus('${a.id}',this.value)" style="width:auto;padding:5px 8px;font-size:12px">
        <option value="have" ${a.status === 'have' ? 'selected' : ''}>自用</option>
        <option value="list" ${a.status === 'list' ? 'selected' : ''}>可交换</option>
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

function renderNotices() {
  const list = (S.notices || []).slice(-8).reverse();
  $('#notices').innerHTML = list.length ? list.map(n => `
    <div class="tcard"><div class="lenflex">
      <span class="muted">${n.player || ''} · ${new Date(n.t * 1000).toLocaleString('zh-CN', { hour12: false })}</span>
    </div><div style="font-size:13px">${n.note}</div></div>`).join('')
    : '<div class="empty">还没有记录</div>';
}

/* ---------------- 本地识别（秒级，不走云端） ---------------- */
let pendingSlots = [], pendingBadges = [];
$('#pickBtn').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!ME) { toast('请先登录'); openAuth(); return; }
  $('#upHint').textContent = '识别中…（首次需加载 OCR 模型约 3 秒）';
  $('#resultCard').classList.add('hidden');
  try {
    const t0 = performance.now();
    const res = await REC.recognize(f, (i, n) => { $('#upHint').textContent = `识别中… ${i + 1}/${n}`; });
    if (!res.ok) { $('#upHint').textContent = ''; toast(res.note); return; }
    pendingSlots = res.slots.map(s => ({
      type_key: s.type_key || '', level: s.level, bonus: s.bonus,
      side: s.side || '', module: s.module || '', status: 'have',
      plate: s.plate, badge_img: s.badge_img, badge_present: !!s.badge_present,
      sig: s.sig || '', slot: s.slot
    }));
    renderResult();
    const ms = Math.round(performance.now() - t0);
    $('#upHint').textContent = `识别完成 ${pendingSlots.length} 件 · ${ms} ms`;
  } catch (err) {
    $('#upHint').textContent = '';
    toast('识别失败：' + err.message);
  } finally {
    $('#file').value = '';
  }
};

function clearResult() { pendingSlots = []; $('#resultCard').classList.add('hidden'); $('#file').value = ''; }

function renderResult() {
  $('#resultCard').classList.remove('hidden');
  $('#resCount').textContent = `共 ${pendingSlots.length} 件`;
  $('#resHint').textContent = '核对一下再入库：类型按颜色估的，可能有错；等级/加成留空说明没认出来，手动填上即可。';
  const tOpts = k => ['<option value="">未知</option>'].concat(
    TYPES.map(t => `<option value="${t.key}" ${t.key === k ? 'selected' : ''}>${t.name}</option>`)).join('');
  const mOpts = k => ['<option value="">无/未识别</option>'].concat(
    MODULES.map(m => `<option value="${m[0]}" ${m[0] === k ? 'selected' : ''}>${m[1]}</option>`)).join('');
  $('#resGrid').innerHTML = pendingSlots.map((s, i) => `
    <div class="slot">
      ${s.plate ? `<img class="plate" src="${s.plate}">` : '<div class="empty">无图</div>'}
      <label class="f">类型</label><select data-i="${i}" data-k="type_key">${tOpts(s.type_key)}</select>
      <div class="grid2" style="margin-top:4px">
        <div><label class="f">等级</label><input data-i="${i}" data-k="level" type="number" value="${s.level == null ? '' : s.level}"></div>
        <div><label class="f">加成%</label><input data-i="${i}" data-k="bonus" type="number" value="${s.bonus == null ? '' : s.bonus}"></div>
      </div>
      <label class="f">量子强化${s.module ? '（图标签名已匹配）' : (s.badge_present ? '（有图标，待标定）' : '（无图标）')}</label><select data-i="${i}" data-k="module">${mOpts(s.module)}</select>
      <div class="grid2" style="margin-top:4px">
        <div><label class="f">光/暗</label><select data-i="${i}" data-k="side">
          <option value="" ${!s.side ? 'selected' : ''}>—</option>
          <option ${s.side === '光' ? 'selected' : ''}>光</option><option ${s.side === '暗' ? 'selected' : ''}>暗</option></select></div>
        <div><label class="f">状态</label><select data-i="${i}" data-k="status">
          <option value="have" ${s.status === 'have' ? 'selected' : ''}>自用</option>
          <option value="list" ${s.status === 'list' ? 'selected' : ''}>可交换</option></select></div>
      </div>
    </div>`).join('');
  $('#resGrid').querySelectorAll('select,input').forEach(el => {
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
      module: s.module || '', side: s.side || '', status: s.status || 'have',
      note: '', img: '', badge_img: s.badge_img || '', sig: s.sig || '',
      module_src: s.module ? 'manual' : '',
      t: Math.floor(Date.now() / 1000)
    }));
    await mutate(d => {
      d.templates = d.templates || {};
      for (const it of items) {
        if (!it.module || !it.sig) continue;
        const t = d.templates[it.module] = d.templates[it.module] || { side: it.side, sigs: [] };
        if (it.side) t.side = it.side;
        if (!t.sigs.includes(it.sig)) t.sigs.push(it.sig);
      }
      d.artifacts = (d.artifacts || []).concat(items);
      d.notices = (d.notices || []).concat([{
        t: Math.floor(Date.now() / 1000), player: ME.name, img: '',
        note: `本地识别入库 ${items.length} 件`
      }]).slice(-30);
    }, `入库 ${items.length} 件神器`);
    toast(`已入库 ${items.length} 件`);
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
    module: '', side: '', status: 'have', note: '', img: '', badge_img: '', sig: '',
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
  editing = S.artifacts.find(a => a.id === id);
  if (!editing) return;
  $('#eType').innerHTML = TYPES.map(t => `<option value="${t.key}" ${t.key === editing.type_key ? 'selected' : ''}>${t.name}</option>`).join('');
  $('#eModule').innerHTML = ['<option value="">无/未识别</option>'].concat(
    MODULES.map(m => `<option value="${m[0]}" ${m[0] === editing.module ? 'selected' : ''}>${m[1]}</option>`)).join('');
  $('#eSide').value = editing.side || '';
  $('#eLevel').value = editing.level || '';
  $('#eBonus').value = editing.bonus || '';
  $('#eSave').onclick = saveEdit;
  $('#dlgEdit').showModal();
}

async function saveEdit() {
  const a = editing;
  const patch = {
    type_key: $('#eType').value, module: $('#eModule').value, side: $('#eSide').value,
    level: $('#eLevel').value ? +$('#eLevel').value : null,
    bonus: $('#eBonus').value ? +$('#eBonus').value : null
  };
  try {
    await mutate(d => {
      const x = d.artifacts.find(y => y.id === a.id);
      if (!x) return false;
      Object.assign(x, patch);
      // 自学习：模块 + 角标签名 → 模板，下次识别就能认出来
      if (patch.module && x.side && x.sig) {
        d.templates = d.templates || {};
        const t = d.templates[patch.module] = d.templates[patch.module] || { side: x.side, sigs: [] };
        t.side = x.side;
        if (!t.sigs.includes(x.sig)) t.sigs.push(x.sig);
        x.module_src = 'manual';
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
    type_key: $('#nType').value, module: $('#nModule').value, side: $('#nSide').value,
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
    ${dlgArtifact.module ? moduleName(dlgArtifact.module) : ''} ${dlgArtifact.side || ''} · 持有者 ${playerName(dlgArtifact.owner)}`;
  const mine = S.artifacts.filter(a => a.owner === ME.id && a.status !== 'reserved');
  $('#dlgGive').innerHTML = '<option value="">不指定</option>'
    + mine.map(a => `<option value="${a.id}">${typeName(a.type_key)} ${a.level ? 'Lv' + a.level : ''} ${a.bonus ? '+' + a.bonus + '%' : ''} ${a.module ? moduleName(a.module) : ''} ${a.side || ''}</option>`).join('');
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
          if (g) { g.owner = t.to; g.status = 'have'; }
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
['#fType', '#fModule', '#fSide'].forEach(s => document.addEventListener('change', e => { if (e.target.matches(s)) renderMarket(); }));

load();
