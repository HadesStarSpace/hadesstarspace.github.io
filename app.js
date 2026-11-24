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
let ME = JSON.parse(localStorage.getItem('qs_me') || 'null');
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
  const me = S.players.find(p => ME && p.id === ME.id);
  if (me) { ME = me; localStorage.setItem('qs_me', JSON.stringify(me)); }
  $('#meName').textContent = me ? me.name : '未登记';
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
  if (!ME) { $('#wantList').innerHTML = '<div class="empty">先登记身份</div>'; $('#offerList').innerHTML = ''; return; }
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
  if (!ME) { $('#inList').innerHTML = $('#outList').innerHTML = '<div class="empty">先登记身份</div>'; return; }
  const inc = S.trades.filter(t => t.to === ME.id).reverse();
  const out = S.trades.filter(t => t.from === ME.id).reverse();
  $('#inList').innerHTML = inc.length ? inc.map(t => tradeRow(t, true)).join('') : '<div class="empty">还没有人向你发起交换</div>';
  $('#outList').innerHTML = out.length ? out.map(t => tradeRow(t, false)).join('') : '<div class="empty">你还没发起过交换</div>';
}

function renderMine() {
  if (!ME) { $('#mineList').innerHTML = $('#myNeedList').innerHTML = '<div class="empty">先登记身份</div>'; return; }
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

/* ---------------- 上传识别 ---------------- */
$('#pickBtn').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!ME) { toast('请先登记身份'); openMe(); return; }
  $('#upHint').textContent = '上传中…';
  try {
    const dataUrl = await downscale(f, 1240, 0.92);
    const b64 = dataUrl.split(',')[1];
    const fn = b64url(ME.name) + '__' + Date.now() + '.jpg';
    const r = await fetch(API + '/contents/' + pathEnc('inbox/' + fn), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, H),
      body: JSON.stringify({ message: '上传截图 ' + ME.name, content: b64, branch: GH.branch })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.message || ('上传失败 ' + r.status));
    }
    $('#upHint').textContent = '已上传';
    startPolling(S.artifacts.length);
  } catch (err) {
    $('#upHint').textContent = '';
    toast('上传失败：' + err.message);
  } finally {
    $('#file').value = '';
  }
};

function downscale(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

async function startPolling(baseCount) {
  if (polling) return;
  polling = true;
  $('#queueCard').classList.remove('hidden');
  const t0 = Date.now();
  let dots = 0;
  while (Date.now() - t0 < 180000) {
    dots = (dots + 1) % 4;
    const secs = Math.round((Date.now() - t0) / 1000);
    $('#queueBox').innerHTML = `<div class="queue"><div class="spin"></div>
      <span>云端识别中${'.'.repeat(dots)}（已等 ${secs}s，一般 30–60 秒）</span></div>`;
    await sleep(5000);
    const d = await readData();
    if (d && d.artifacts.length > baseCount) {
      polling = false;
      const added = d.artifacts.length - baseCount;
      $('#queueBox').innerHTML = `<div style="color:var(--accent)">识别完成，新增 ${added} 件，已放入「我的」</div>`;
      await load();
      switchTab('mine');
      toast(`识别完成，新增 ${added} 件`);
      return;
    }
  }
  polling = false;
  $('#queueBox').innerHTML = '<div class="muted">等待超时。可到仓库 Actions 页查看识别日志；若识别失败会在「识别记录」里写明原因。</div>';
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
  if (!ME) { toast('请先登记身份'); openMe(); return; }
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
  if (!ME) { toast('请先登记身份'); openMe(); return; }
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

/* ---------------- 身份 ---------------- */
function openMe() {
  const name = prompt('输入你在集团的游戏名：', ME ? ME.name : '');
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const found = S.players.find(p => p.name === trimmed);
  if (found) {
    ME = found;
  } else {
    ME = { id: 'p' + Date.now().toString(36), name: trimmed, note: '' };
    mutate(d => { d.players = d.players || []; d.players.push(ME); }, '新成员 ' + trimmed)
      .then(() => load()).catch(e => toast('登记失败：' + e.message));
  }
  localStorage.setItem('qs_me', JSON.stringify(ME));
  $('#meName').textContent = ME.name;
  toast('身份：' + ME.name);
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
