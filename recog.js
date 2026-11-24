/* 浏览器端神器识别：OpenCV 算法的 JS 版（HSV 掩膜 + 连通域 + 局部 OCR）
 * 与 Python 版 recognize.py 同参数，作用是把识别从「GitHub Actions 排队」搬到本地，秒级出结果。
 */
const REC = (() => {
  const TYPES = [
    { name: '运输舰', rgb: [232, 195, 74], key: 'trade', hue: 23 },
    { name: '采矿', rgb: [167, 107, 240], key: 'mining', hue: 134 },
    { name: '支援', rgb: [95, 196, 106], key: 'support', hue: 63 },
    { name: '战斗', rgb: [226, 87, 76], key: 'weapon', hue: 2 },
    { name: '护盾', rgb: [76, 194, 240], key: 'shield', hue: 98 },
    { name: '无人机', rgb: [240, 154, 60], key: 'drone', hue: 16 }
  ];
  const chroma = rgb => { const s = rgb[0] + rgb[1] + rgb[2] + 1e-6; return [rgb[0] / s, rgb[1] / s, rgb[2] / s]; };
  const REFS = TYPES.map(t => ({ ref: chroma(t.rgb), name: t.name, key: t.key, hue: t.hue }));

  /* ---------- 颜色空间 ---------- */
  function toHSV(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 30; if (h < 0) h += 180;
    }
    const s = mx === 0 ? 0 : (d / mx) * 255;
    return [h, s, mx];
  }

  /* ---------- Otsu ---------- */
  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      const wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  /* ---------- 版面定位（半分辨率） ---------- */
  function findPlates(imageData, opt) {
    const minS = (opt && opt.minS) || 45, maxS = (opt && opt.maxS) || 110, maxN = (opt && opt.maxN) || 40;
    const { width: W, height: H, data } = imageData;
    const sw = Math.max(1, Math.round(W / 2)), sh = Math.max(1, Math.round(H / 2));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sc = small.getContext('2d');
    sc.drawImage(imageData.canvas || canvasOf(imageData), 0, 0, sw, sh);
    const sd = sc.getImageData(0, 0, sw, sh).data;
    const mask = new Uint8Array(sw * sh);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const hsv = toHSV(sd[p], sd[p + 1], sd[p + 2]);
      if (hsv[1] > 55 && hsv[2] > 80) mask[i] = 1;
    }
    // 形态学闭运算（膨胀半径2 → 腐蚀半径2），把环上的小圆点连成一整块
    const dil = boxFilter(mask, sw, sh, 2, true);
    const cleaned = boxFilter(dil, sw, sh, 2, false);
    // 连通域
    const labels = new Int32Array(sw * sh).fill(0);
    const boxes = [];
    const stack = new Int32Array(sw * sh);
    let cur = 0;
    for (let i = 0; i < cleaned.length; i++) {
      if (!cleaned[i] || labels[i]) continue;
      cur++;
      let sp = 0; stack[sp++] = i; labels[i] = cur;
      let minX = sw, maxX = 0, minY = sh, maxY = 0, area = 0, sx = 0, sy = 0;
      while (sp) {
        const p = stack[--sp];
        const px = p % sw, py = (p - px) / sw;
        area++; sx += px; sy += py;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy; if (ny < 0 || ny >= sh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx; if (nx < 0 || nx >= sw) continue;
            const q = ny * sw + nx;
            if (cleaned[q] && !labels[q]) { labels[q] = cur; stack[sp++] = q; }
          }
        }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      // 贴图边的半截格子也收（截图上下被裁掉时常见）
      const edge = minX <= 1 || minY <= 1 || maxX >= sw - 2 || maxY >= sh - 2;
      const okSize = (w >= minS && w <= maxS && h >= minS && h <= maxS)
        || (edge && w >= 0.55 * minS && h >= 0.55 * minS && w <= maxS * 1.6 && h <= maxS * 1.6);
      if (!okSize) continue;
      if (area < 900 || area < 0.28 * w * h) continue;
      boxes.push({ cx: (minX + maxX + 1) / 2 * 2, cy: (minY + maxY + 1) / 2 * 2, w: w * 2, h: h * 2, area });
    }
    boxes.sort((a, b) => b.area - a.area);
    const keep = [];
    for (const b of boxes) {
      if (keep.every(k => Math.abs(b.cx - k.cx) > 0.6 * k.w || Math.abs(b.cy - k.cy) > 0.6 * k.h)) keep.push(b);
    }
    // 按行再按列排序
    const rows = [];
    keep.sort((a, b) => a.cy - b.cy);
    for (const b of keep) {
      const row = rows.find(r => Math.abs(b.cy - r.cy) < 0.8 * b.h);
      if (row) { row.list.push(b); row.cy = (row.cy * row.list.length + b.cy) / (row.list.length + 1); }
      else rows.push({ cy: b.cy, list: [b] });
    }
    const out = [];
    rows.forEach(r => { r.list.sort((a, b) => a.cx - b.cx); r.list.forEach(b => out.push(b)); });
    return out;
  }

  /** 可分离 box 膨胀/腐蚀（半径 r） */
  function boxFilter(src, w, h, r, dilate) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const pass = (input, output, width, height, horizontal) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let hit = 0;
          for (let k = -r; k <= r; k++) {
            const nx = horizontal ? x + k : y + k;
            if (nx < 0 || nx >= (horizontal ? width : height)) continue;
            const v = input[horizontal ? y * width + nx : nx * width + x];
            if (dilate ? v : !v) { hit = 1; break; }
          }
          output[y * width + x] = dilate ? hit : (hit ? 0 : 1);
        }
      }
    };
    pass(src, tmp, w, h, true);
    pass(tmp, out, w, h, false);
    return out;
  }

  function canvasOf(imageData) {
    const c = document.createElement('canvas');
    c.width = imageData.width; c.height = imageData.height;
    c.getContext('2d').putImageData(imageData, 0, 0);
    return c;
  }

  /* ---------- 单槽位几何 ---------- */
  function crop(src, x0, y0, x1, y1) {
    const canvas = src.canvas || src;
    const W = canvas.width, H = canvas.height;
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(W, Math.round(x1)); y1 = Math.min(H, Math.round(y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    const c = document.createElement('canvas');
    c.width = x1 - x0; c.height = y1 - y0;
    c.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    return { canvas: c, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function grayOf(canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const g = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0, k = 0; i < g.length; i++, k += 4) g[i] = Math.round(0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]);
    return g;
  }

  /** 最亮块（找药丸/等级小框） */
  function brightestBox(img, box, minArea) {
    const canvas = img.canvas || img;
    const width = canvas.width, height = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const x0 = Math.max(0, Math.round(box[0])), y0 = Math.max(0, Math.round(box[1]));
    const x1 = Math.min(width, Math.round(box[2])), y1 = Math.min(height, Math.round(box[3]));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const mw = x1 - x0, mh = y1 - y0;
    const mask = new Uint8Array(mw * mh);
    let best = null;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const p = ((y0 + y) * width + (x0 + x)) * 4;
        const hsv = toHSV(data[p], data[p + 1], data[p + 2]);
        if (hsv[2] > 105 && hsv[1] > 40) mask[y * mw + x] = 1;
      }
    }
    // 连通域求最亮块
    const labels = new Int32Array(mw * mh);
    const stack = new Int32Array(mw * mh);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || labels[i]) continue;
      let sp = 0; stack[sp++] = i; labels[i] = 1;
      let minX = mw, maxX = 0, minY = mh, maxY = 0, area = 0;
      while (sp) {
        const q = stack[--sp];
        const qx = q % mw, qy = (q - qx) / mw;
        area++; if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = qy + dy; if (ny < 0 || ny >= mh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx; if (nx < 0 || nx >= mw) continue;
            const r2 = ny * mw + nx;
            if (mask[r2] && !labels[r2]) { labels[r2] = 1; stack[sp++] = r2; }
          }
        }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      if (area < minArea || w < 12 || h < 10) continue;
      if (!best || area > best[4]) best = [x0 + minX, y0 + minY, w, h, area];
    }
    return best;
  }

  /* ---------- OCR ---------- */
  let worker = null, workerReady = null, ocrQueue = Promise.resolve(), ocrQueueStarted = false;
  const CDN = 'https://cdn.jsdelivr.net/gh/lindatou1314/qs-exchange@main/tess/';
  function ensureWorker(onLog) {
    if (workerReady) return workerReady;
    // 先走 jsDelivr CDN（国内比 GitHub Pages 快很多），失败再回落到本站 tess/
    const tries = [
      { workerPath: CDN + 'worker.min.js', corePath: CDN.replace(/\/$/, ''), langPath: CDN, cacheMethod: 'write' },
      { workerPath: 'tess/worker.min.js', corePath: 'tess', langPath: 'tess', cacheMethod: 'write' }
    ];
    const log = onLog || (() => { });
    workerReady = (async () => {
      let lastErr;
      for (const opt of tries) {
        try {
          const w = await Tesseract.createWorker('eng', 1, Object.assign({ logger: log }, opt));
          worker = w; return w;
        } catch (e) { lastErr = e; }
      }
      workerReady = null;
      throw lastErr || new Error('OCR 初始化失败');
    })();
    return workerReady;
  }

  /** 把 canvas 预处理成 OCR 输入：缩放到高 300 + 二值化 */
  function prep(canvas, mode) {
    const targetH = 300;
    const scale = Math.max(1, targetH / canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(canvas, 0, 0, c.width, c.height);
    const id = g.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    const gray = new Uint8Array(c.width * c.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = mode === 'green'
        ? d[p + 1]
        : Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
    }
    if (mode !== 'raw') {
      const thr = mode === 'fixed' ? 215 : otsu(gray);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        const v = gray[i] > thr ? 255 : 0;
        d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
      }
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
  }
  function ocr(canvas, psm, whitelist, mode) {
    ocrQueue = ocrQueue.then(async () => {
      const w = await withTimeout(ensureWorker(), ocrQueueStarted ? 8000 : 30000);
      ocrQueueStarted = true;
      if (!w) return '';
      await withTimeout(w.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: whitelist || ''
      }), 5000);
      const r = await withTimeout(w.recognize(prep(canvas, mode)), 8000);
      if (!r) return '';
      return (r.data.text || '').replace(/\s+/g, '');
    });
    return ocrQueue.catch(() => '');
  }

  /* ---------- 数字读法：先定位、再多版本 OCR 共识 ---------- */
  /** 灰度分位拉伸 + 放大，给 OCR 用（不做二值化，避免细笔画被吃掉） */
  function stretch(cc, lo, hi, scale) {
    const g = cc.canvas.getContext('2d');
    const d = g.getImageData(0, 0, cc.w, cc.h).data;
    const n = cc.w * cc.h;
    const gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    const pick = (q) => { const need = n * q / 100; let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= need) return i; } return 255; };
    const p1 = pick(lo), p2 = pick(hi);
    const span = Math.max(1, p2 - p1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cc.w * scale)); c.height = Math.max(1, Math.round(cc.h * scale));
    const cg = c.getContext('2d');
    const id = cg.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) {
      const sy = Math.min(cc.h - 1, Math.floor(y / scale));
      for (let x = 0; x < c.width; x++) {
        const sx = Math.min(cc.w - 1, Math.floor(x / scale));
        const v = Math.max(0, Math.min(255, ((gray[sy * cc.w + sx] - p1) / span) * 255));
        const k = (y * c.width + x) * 4;
        id.data[k] = id.data[k + 1] = id.data[k + 2] = v; id.data[k + 3] = 255;
      }
    }
    cg.putImageData(id, 0, 0);
    // 四周留白，tesseract 对贴边文字很不友好
    const pad = 14;
    const out = document.createElement('canvas');
    out.width = c.width + pad * 2; out.height = c.height + pad * 2;
    const og = out.getContext('2d');
    og.fillStyle = '#000'; og.fillRect(0, 0, out.width, out.height);
    og.drawImage(c, pad, pad);
    return out;
  }

  // 每个版本 = [预处理, psm]；灰度拉伸与直接二值化各来几组，互相投票
  const NUM_VARIANTS = [
    [(cc) => cc.canvas, 7, 'otsu'],
    [(cc) => cc.canvas, 8, 'green'],
    [(cc) => stretch(cc, 2, 98, 6), 8, 'raw'],
    [(cc) => stretch(cc, 5, 95, 6), 7, 'raw'],
    [(cc) => stretch(cc, 10, 90, 6), 8, 'raw'],
    [(cc) => stretch(cc, 2, 98, 3), 7, 'raw'],
    [(cc) => stretch(cc, 5, 95, 10), 7, 'raw'],
    [(cc) => stretch(cc, 10, 90, 3), 8, 'raw']
  ];
  /** 对一块区域做多版本 OCR，投票选数字；返回 {v, votes, total} 或 null */
  async function voteNumber(cc, minv, maxv, nDigits) {
    if (!cc) return null;
    const tally = {};
    let total = 0;
    for (const [mk, psm, mode] of NUM_VARIANTS) {
      const t = await ocr(mk(cc), psm, '0123456789', mode);
      const digits = (t.match(/\d+/g) || []).join('');
      if (!digits) continue;
      if (nDigits && digits.length !== nDigits) continue;
      const v = parseInt(digits, 10);
      if (v < minv || v > maxv) continue;
      tally[v] = (tally[v] || 0) + 1; total++;
      if (tally[v] >= 3) break;      // 三家同意就收工，省时间
    }
    let best = null, bn = 0;
    for (const k in tally) if (tally[k] > bn) { bn = tally[k]; best = parseInt(k, 10); }
    if (!best || bn < 2 || bn < total * 0.5) return null;
    return { v: best, votes: bn, total };
  }

  /** 在区域里找“一串数字”文字块：返回 {box, n} */
  function findDigitRun(img, x0, y0, x1, y1, thr) {
    const cc = crop(img, x0, y0, x1, y1);
    if (!cc) return null;
    const d = cc.canvas.getContext('2d').getImageData(0, 0, cc.w, cc.h).data;
    const n = cc.w * cc.h;
    const mask = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const g = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      mask[i] = g > thr ? 1 : 0;
    }
    // 连通域（4 邻域）
    const lab = new Int32Array(n).fill(-1);
    const stack = [];
    const comps = [];
    for (let start = 0; start < n; start++) {
      if (!mask[start] || lab[start] >= 0) continue;
      const id = comps.length;
      const box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 };
      stack.push(start); lab[start] = id;
      while (stack.length) {
        const p = stack.pop();
        const x = p % cc.w, y = (p - x) / cc.w;
        box.n++;
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
        const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (const [nx, ny] of nb) {
          if (nx < 0 || ny < 0 || nx >= cc.w || ny >= cc.h) continue;
          const q = ny * cc.w + nx;
          if (mask[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
        }
      }
      comps.push(box);
    }
    const glyphs = comps.filter(b => {
      const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
      return h >= 13 && h <= 32 && w >= 2 && w <= 46 && b.n >= 12;
    }).map(b => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }));
    // 按行聚（竖直中心相近）
    const lines = [];
    for (const g of glyphs.sort((a, b) => a.y - b.y)) {
      const line = lines.find(L => Math.abs((L.cy) - (g.y + g.h / 2)) < 9);
      if (line) { line.items.push(g); line.cy = (line.cy * (line.items.length - 1) + g.y + g.h / 2) / line.items.length; }
      else lines.push({ cy: g.y + g.h / 2, items: [g] });
    }
    // 每行从右往左收窄字（数字），遇到宽字（汉字）停
    for (const L of lines) {
      L.items.sort((a, b) => a.x - b.x);
      const digits = [];
      for (let i = L.items.length - 1; i >= 0; i--) {
        const g = L.items[i];
        if (g.w <= 0.62 * g.h + 1) digits.unshift(g);
        else if (digits.length) break;
      }
      if (digits.length && digits.length <= 2) {
        const xa = Math.min(...digits.map(g => g.x)) - 1;
        const xb = Math.max(...digits.map(g => g.x + g.w)) + 1;
        const ya = Math.min(...digits.map(g => g.y)) - 1;
        const yb = Math.max(...digits.map(g => g.y + g.h)) + 1;
        return { box: [cc.x + xa, cc.y + ya, cc.x + xb, cc.y + yb], n: digits.length };
      }
    }
    return null;
  }

  /* ---------- 识别单个槽位 ---------- */
  /** 在区域里找青绿色药丸底板（列表版式的 +360% 药丸就是这个色） */
  function findTealPill(img, band, minArea) {
    const cc = crop(img, band[0], band[1], band[2], band[3]);
    if (!cc) return null;
    const d = cc.canvas.getContext('2d').getImageData(0, 0, cc.w, cc.h).data;
    const n = cc.w * cc.h;
    const mask = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      mask[i] = (g > 72 && g - r > 18 && b > 45 && g - b >= 6 && g < 200) ? 1 : 0;
    }
    const lab = new Int32Array(n).fill(-1);
    const stack = [];
    let best = null;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || lab[start] >= 0) continue;
      const id = 1;
      const box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, n: 0 };
      stack.push(start); lab[start] = id;
      while (stack.length) {
        const p = stack.pop();
        const x = p % cc.w, y = (p - x) / cc.w;
        box.n++;
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1], [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= cc.w || ny >= cc.h) continue;
          const q = ny * cc.w + nx;
          if (mask[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
        }
      }
      if (box.n >= (minArea || 2500) && (!best || box.n > best.n)) best = box;
    }
    if (!best) return null;
    return [cc.x + best.x0, cc.y + best.y0, cc.x + best.x1 + 1, cc.y + best.y1 + 1];
  }

  async function readBonus(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const list = W > 170;
    const main = list
      ? [cx - 0.10 * W, cy - 0.12 * W, cx + 1.05 * W, cy + 0.52 * W]    // 列表面板：药丸在格子右下
      : [cx - 0.80 * W, cy - 1.75 * W, cx + 0.95 * W, cy - 0.90 * W];   // 容器卡片：药丸在格子上方
    const alt = list
      ? [cx - 0.20 * W, cy + 0.50 * W, cx + 0.95 * W, cy + 1.15 * W]
      : [cx - 0.20 * W, cy + 0.60 * W, cx + 0.95 * W, cy + 1.25 * W];
    const lowerRight = [cx - 0.25 * W, cy + 0.05 * W, cx + 1.55 * W, cy + 1.25 * W];

    // 两种版式都先按颜色找青绿药丸底板，只读药丸内部，最稳
    const searches = list
      ? [[cx - 0.50 * W, cy - 0.10 * W, cx + 0.80 * W, cy + 0.70 * W],
         [cx - 0.20 * W, cy + 0.45 * W, cx + 1.00 * W, cy + 1.20 * W]]
      : [[cx - 0.90 * W, cy - 1.90 * W, cx + 1.00 * W, cy - 0.80 * W],
         [cx - 0.20 * W, cy + 0.55 * W, cx + 1.00 * W, cy + 1.30 * W]];
    for (const search of searches) {
      for (const minArea of [1500, 800]) {
        const box = findTealPill(img, search, minArea);
        if (!box) continue;
        const cc2 = crop(img, box[0] + 2, box[1] + 2, box[2] - 2, box[3] - 2);
        const got = await voteNumber(cc2, 280, 420, 3);
        if (got) return got.v;
      }
    }

    for (const box of [main, alt, lowerRight]) {
      const b = brightestBox(img, box, 900);
      const cc = (b && b[2] / b[3] > 1.4 && b[2] / b[3] < 3.4)
        ? crop(img, b[0] - 3, b[1] - 3, b[0] + b[2] + 3, b[1] + b[3] + 3)
        : crop(img, box[0], box[1], box[2], box[3]);
      if (!cc) continue;
      const got = await voteNumber(cc, 280, 420, 3);
      if (got) return got.v;
    }
    return null;
  }

  async function readLevel(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;

    // 列表版式（货物/仓库）：等级是文字列里的「等级NN」，先定位小数字再投票
    if (W > 170) {
      const zones = [
        [cx - 2.75 * W, cy - 0.85 * W, cx - 1.70 * W, cy + 0.55 * W],
        [cx - 3.10 * W, cy - 1.20 * W, cx - 1.70 * W, cy + 0.90 * W]
      ];
      for (const z of zones) {
        for (const thr of [58, 66]) {
          const run = findDigitRun(img, z[0], z[1], z[2], z[3], thr);
          if (!run) continue;
          const got = await voteNumber(crop(img, run.box[0], run.box[1], run.box[2], run.box[3]), 8, 30, run.n);
          if (got) return got.v;
        }
      }
    }

    // 容器卡片：左下角的大号数字徽标
    const pick = async (band, psms) => {
      const cc = crop(img, band[0], band[1], band[2], band[3]);
      if (!cc) return null;
      for (const psm of psms) {
        const t = await ocr(cc.canvas, psm, '0123456789', 'otsu');
        const nums = (t.match(/\d{1,2}/g) || []).map(x => parseInt(x, 10)).filter(n => n >= 8 && n <= 15);
        if (nums.length) return nums[0];
      }
      return null;
    };
    const v = await pick([cx - 0.80 * W, cy + 0.86 * W, cx - 0.38 * W, cy + 1.32 * W], [10, 7]);
    if (v != null) return v;
    return await pick([cx - 2.4 * W, cy - 1.05 * W, cx - 0.55 * W, cy - 0.15 * W], [7]);
  }

  // 颜色→类型：按「圆点环带」的色相直方图判定，跳过泛光青色（hue 75~92）
  const HUE_TYPES = [
    { lo: 0, hi: 9, key: 'weapon', name: '战斗' },
    { lo: 9, hi: 20, key: 'drone', name: '无人机' },
    { lo: 20, hi: 42, key: 'trade', name: '运输舰' },
    { lo: 42, hi: 56, key: 'drone', name: '无人机' },
    { lo: 56, hi: 74, key: 'support', name: '支援' },
    { lo: 93, hi: 110, key: 'shield', name: '护盾' },
    { lo: 110, hi: 150, key: 'mining', name: '采矿' },
    { lo: 150, hi: 180, key: 'weapon', name: '战斗' }
  ];
  function classify(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const cc = crop(img, cx - 0.5 * W, cy - 0.5 * W, cx + 0.5 * W, cy + 0.5 * W);
    if (!cc) return { name: null, key: null, score: 9 };
    const d = cc.canvas.getContext('2d').getImageData(0, 0, cc.w, cc.h).data;
    const rIn = 0.30 * W, rOut = 0.50 * W;
    const hist = new Float64Array(180);
    let n = 0;
    for (let y = 0; y < cc.h; y++) {
      for (let x = 0; x < cc.w; x++) {
        const dx = x - (cx - cc.x), dy = y - (cy - cc.y);
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < rIn || r > rOut) continue;
        const k = (y * cc.w + x) * 4;
        const hsv = toHSV(d[k], d[k + 1], d[k + 2]);
        if (hsv[1] < 80 || hsv[2] < 90) continue;
        const h = Math.round(hsv[0]);
        if (h >= 75 && h <= 92) continue;   // 平台泛光，不代表类型
        hist[h < 180 ? h : 0]++; n++;
      }
    }
    if (n < 60) return { name: null, key: null, score: 9 };
    const buckets = {};
    for (const t of HUE_TYPES) {
      let c = 0;
      for (let h = t.lo; h < t.hi; h++) c += hist[h] + (hist[h + 180] || 0);
      buckets[t.key + '|' + t.name] = (buckets[t.key + '|' + t.name] || 0) + c;
    }
    let best = null;
    for (const t of HUE_TYPES) {
      const k = t.key + '|' + t.name;
      const c = buckets[k] || 0;
      if (!best || c > best.c) best = { c, key: t.key, name: t.name };
    }
    // 置信度：主类型占比。低于 0.35 视为不确定
    const share = best.c / n;
    return { name: share >= 0.35 ? best.name : null, key: share >= 0.35 ? best.key : null, score: 1 - share };
  }



  function shrink(canvas, size) {
    const s = Math.min(1, size / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s));
    c.height = Math.max(1, Math.round(canvas.height * s));
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /* 量子强化图标：区域固定，取 16x16 灰度签名用于模板比对 */
  function b64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 在底板右侧扫一块“亮色均匀方块”（白牌/灰牌）：四角明显比内部暗，用来排除背景和药丸 */
  function findLightBadge(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const R = crop(img, cx - 1.0 * W, cy - 1.3 * W, cx + 1.6 * W, cy + 1.1 * W);
    if (!R) return null;
    const rw = R.w, rh = R.h;
    const d = R.canvas.getContext('2d').getImageData(0, 0, rw, rh).data;
    // 灰度 + 亮牌掩膜
    const g = new Float32Array(rw * rh), m = new Float32Array(rw * rh);
    for (let i = 0, k = 0; i < g.length; i++, k += 4) {
      const hsv = toHSV(d[k], d[k + 1], d[k + 2]);
      g[i] = hsv[2];
      m[i] = (hsv[2] > 95 && hsv[1] < 70) ? 1 : 0;
    }
    const gw = rw + 1;
    const I = new Float64Array(gw * (rh + 1)), M = new Float64Array(gw * (rh + 1));
    for (let y = 0; y < rh; y++) {
      let sg = 0, sm = 0;
      for (let x = 0; x < rw; x++) {
        sg += g[y * rw + x]; sm += m[y * rw + x];
        I[(y + 1) * gw + x + 1] = I[y * gw + x + 1] + sg;
        M[(y + 1) * gw + x + 1] = M[y * gw + x + 1] + sm;
      }
    }
    const sum = (A, x0, y0, x1, y1) => A[y1 * gw + x1] - A[y0 * gw + x1] - A[y1 * gw + x0] + A[y0 * gw + x0];
    const area = S => S * S;
    let best = null;
    for (const sr of [0.30, 0.38, 0.46]) {
      const S = Math.round(sr * W);
      if (S < 12) continue;
      for (let py = cy - 1.0 * W; py <= cy + 0.5 * W; py += 0.05 * W) {
        for (let px = cx + 0.35 * W; px <= cx + 1.15 * W; px += 0.05 * W) {
          const x0 = Math.round(px - R.x - S / 2), y0 = Math.round(py - R.y - S / 2);
          const x1 = x0 + S, y1 = y0 + S;
          if (x0 < 0 || y0 < 0 || x1 > rw || y1 > rh) continue;
          const mf = sum(M, x0, y0, x1, y1) / area(S);
          if (mf < 0.55) continue;
          const mean = sum(I, x0, y0, x1, y1) / area(S);
          // 四角取样（5% 大小），看是否明显比内部暗
          const cs = Math.max(2, Math.round(S * 0.06));
          const corner = (cxp, cyp) => {
            const a = Math.max(0, Math.min(rw - cs, Math.round(cxp)));
            const b = Math.max(0, Math.min(rh - cs, Math.round(cyp)));
            return sum(I, a, b, a + cs, b + cs) / (cs * cs);
          };
          let darker = 0;
          for (const [ax, ay] of [[x0, y0], [x1 - cs, y0], [x0, y1 - cs], [x1 - cs, y1 - cs]]) {
            if (corner(ax + R.x, ay + R.y) < mean - 28) darker++;
          }
          if (darker < 3) continue;
          const score = mf * (darker / 4);
          if (!best || score > best.score) best = { score, mf, mean, x: R.x + x0, y: R.y + y0, S };
        }
      }
    }
    return best;
  }

  /* 多尺度找格子：一张图里可能同时有放大件和小件，单一尺寸窗口会漏 */
  const PLATE_SCALES = [
    { minS: 45, maxS: 110 },
    { minS: 80, maxS: 220 },
    { minS: 140, maxS: 420 }
  ];
  function detectPlates(imgData) {
    // 每个尺度各跑一遍，取“找到格子最多”的那个尺度当主结果（不同尺度混着并会冒出假格子）
    let best = null, bestN = 0, runnerUp = null;
    for (const sc of PLATE_SCALES) {
      const got = findPlates(imgData, { minS: sc.minS, maxS: sc.maxS, maxN: 40 });
      if (got.length > bestN) {
        if (best) runnerUp = best;
        best = got; bestN = got.length;
      } else if (got.length) runnerUp = runnerUp || got;
    }
    if (!best) return [];
    // 第二尺度里尺寸明显不同（大件/小件混排）且不和主结果重叠的，也收进来
    const extra = (runnerUp || []).filter(b => {
      const overlap = best.some(k => Math.abs(b.cx - k.cx) < 0.6 * Math.max(b.w, k.w) &&
                                    Math.abs(b.cy - k.cy) < 0.6 * Math.max(b.h, k.h));
      if (overlap) return false;
      const med = best.slice().sort((p, q) => p.w - q.w)[Math.floor(best.length / 2)].w;
      return b.w > 1.8 * med || b.w < 0.55 * med;
    });
    const out = best.concat(extra);
    // 两格粘成一格（高/宽明显不是方形）就按中线劈开
    const fixed = [];
    for (const b of out) {
      if (b.h > 1.35 * b.w) {
        const hh = b.h / 2;
        fixed.push({ cx: b.cx, cy: b.cy - hh / 2, w: b.w, h: hh, area: b.area / 2 });
        fixed.push({ cx: b.cx, cy: b.cy + hh / 2, w: b.w, h: hh, area: b.area / 2 });
      } else if (b.w > 1.35 * b.h) {
        const ww = b.w / 2;
        fixed.push({ cx: b.cx - ww / 2, cy: b.cy, w: ww, h: b.h, area: b.area / 2 });
        fixed.push({ cx: b.cx + ww / 2, cy: b.cy, w: ww, h: b.h, area: b.area / 2 });
      } else fixed.push(b);
    }
    fixed.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    return fixed;
  }

  /* 量子图标三种版式几何；逐个试，按“像不像一块牌子”打分挑最好的 */
  const BADGE_GEOMS = [
    { ox: 0.62, oy: -0.05, s: 0.46 },   // 列表 / 货物面板：格子右侧
    { ox: 0.49, oy: -0.88, s: 0.46 },   // 文物容器卡片：格子右上
    { ox: 0.82, oy: 0.01, s: 0.43 }     // 单件放大卡片：格子右侧偏上
  ];

  function badgeScore(cc) {
    const d = cc.canvas.getContext('2d').getImageData(0, 0, cc.w, cc.h).data;
    const n = cc.w * cc.h;
    let light = 0, dark = 0, bright = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const hsv = toHSV(d[i], d[i + 1], d[i + 2]);
      sum += hsv[2];
      if (hsv[2] > 85 && hsv[1] < 80) light++;     // 白牌 / 灰牌的底
      if (hsv[2] < 45) dark++;                     // 黑牌的底
      if (hsv[2] > 150) bright++;                  // 牌子里的图案（白字/黄字/彩点）
    }
    return { light: light / n, dark: dark / n, bright: bright / n, mean: sum / n };
  }

  function readBadge(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const lb = findLightBadge(img, p);
    if (lb) {
      const cc2 = crop(img, lb.x - lb.S * 0.02, lb.y - lb.S * 0.02, lb.x + lb.S * 1.02, lb.y + lb.S * 1.02);
      if (cc2) {
        return { present: true, side: lb.mean > 110 ? '光' : '暗',
                 thumb: shrink(cc2.canvas, 48).toDataURL('image/jpeg', 0.85), sig: b64(gradSig(cc2.canvas)) };
      }
    }
    let best = null;
    for (const g of BADGE_GEOMS) {
      const S = g.s * W;
      const px = cx + g.ox * W, py = cy + g.oy * W;
      // 先按放大 8% 的框取，再验证四角不像牌子（防止整块落进背景）
      const cc = crop(img, px - S / 2, py - S / 2, px + S / 2, py + S / 2);
      if (!cc) continue;
      if (cc.w < 0.75 * S || cc.h < 0.75 * S) continue;        // 被图边裁掉的不算
      const sc = badgeScore(cc);
      if (!best || sc.light + sc.dark * 0.6 > best.score) best = { score: sc.light + sc.dark * 0.6, sc, cc };
    }
    if (!best) return { present: false, side: null, thumb: null, sig: '' };
    const sc = best.sc;
    // 亮牌：底色占大头；黑牌：底色深但牌里有亮图案；纯背景两者都不满足
    const present = sc.light >= 0.55 || (sc.dark >= 0.55 && sc.bright >= 0.06);
    const thumb = shrink(best.cc.canvas, 48).toDataURL('image/jpeg', 0.85);
    let sig = '';
    if (present) sig = b64(gradSig(best.cc.canvas));
    return { present, side: sc.mean > 110 ? '光' : '暗', thumb, sig };
  }

  /* 16x16 梯度幅值签名，归一化到 0..255（与底色明暗无关） */
  function gradSig(canvas) {
    const t = shrink(canvas, 32);
    const d = t.getContext('2d').getImageData(0, 0, 32, 32).data;
    const g = new Float32Array(1024);
    for (let i = 0, k = 0; i < 1024; i++, k += 4) g[i] = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
    // 先按 5%~95% 分位拉伸对比度：灰底淡图案（同一个图标两次截图亮度不同）也能对上
    const hist = new Uint32Array(256);
    for (let i = 0; i < 1024; i++) hist[Math.max(0, Math.min(255, Math.round(g[i])))]++;
    const pickq = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 1024 * q) return v; } return 255; };
    const lo = pickq(0.05), hi = pickq(0.95), span = Math.max(8, hi - lo);
    for (let i = 0; i < 1024; i++) g[i] = Math.max(0, Math.min(255, (g[i] - lo) * 255 / span));
    const raw = new Float32Array(256);
    let maxV = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const bx = x * 2, by = y * 2;
        let acc = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = bx + dx, py = by + dy;
            const i = py * 32 + px;
            const gx = g[py * 32 + Math.min(31, px + 1)] - g[py * 32 + Math.max(0, px - 1)];
            const gy = g[Math.min(31, py + 1) * 32 + px] - g[Math.max(0, py - 1) * 32 + px];
            acc += Math.abs(gx) + Math.abs(gy);
          }
        }
        raw[y * 16 + x] = acc / 4;
        if (acc / 4 > maxV) maxV = acc / 4;
      }
    }
    const out = new Uint8Array(256);
    const scale = maxV > 1 ? 255 / maxV : 0;
    for (let i = 0; i < 256; i++) out[i] = Math.round(raw[i] * scale);
    return out;
  }

  /* 模板比对：模块名 → 若干 16x16 签名，取最小归一化距离 */
  let TEMPLATES = null;
  function setTemplates(t) { TEMPLATES = t || null; }
  function sigDistance(a, b) {
    if (a.length !== b.length) return 9;
    let acc = 0;
    for (let i = 0; i < a.length; i++) {
      const d = (a[i] - b[i]) / 255;
      acc += d * d;
    }
    return Math.sqrt(acc / a.length);            // 归一化 RMSE（0~1）
  }
  /* 允许 ±2 格平移的最佳对齐距离：同一图标两次截图有裁切偏移也能对上 */
  function sigAlign(a, b) {
    if (!a || !b || a.length !== b.length || a.length !== 256) return sigDistance(a, b);
    let best = 9;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        let acc = 0, n = 0;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const bx = x + dx, by = y + dy;
            if (bx < 0 || bx > 15 || by < 0 || by > 15) continue;
            const d = (a[by * 16 + bx] - b[y * 16 + x]) / 255;
            acc += d * d; n++;
          }
        }
        const v = Math.sqrt(acc / Math.max(1, n));
        if (v < best) best = v;
      }
    }
    return best;
  }
  const ICON_MATCH = 0.13;

  function matchModule(sigStr) {
    if (!TEMPLATES || !sigStr) return null;
    const cur = unb64(sigStr);
    let best = null;
    for (const [key, t] of Object.entries(TEMPLATES)) {
      for (const s of (t && t.sigs) || []) {
        let d;
        try { d = sigAlign(cur, unb64(s)); } catch (e) { continue; }
        if (!best || d < best.dist) best = { module: key, dist: d, side: t.side || null };
      }
    }
    return best && best.dist < ICON_MATCH ? best : null;
  }

  async function recognize(file, onProgress) {
    const img = await loadImage(file);
    const full = document.createElement('canvas');
    full.width = img.width; full.height = img.height;
    full.getContext('2d').drawImage(img, 0, 0);
    const ctx = { canvas: full, width: img.width, height: img.height };
    const imgData = { canvas: full, width: img.width, height: img.height, data: full.getContext('2d').getImageData(0, 0, img.width, img.height).data };
    let plates = detectPlates(imgData);
    if (!plates.length) plates = findPlates(imgData, { minS: 60, maxS: 420, maxN: 4 });   // 兜底：放大/单件截图
    if (!plates.length) return { ok: false, note: '没找到神器格子，截一张能看清神器底板的图再试' };
    if (plates.length > 12) plates = plates.slice(0, 12);
    const slots = [];
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      if (onProgress) onProgress(i, plates.length);
      const cls = classify(ctx, p);
      const badge = readBadge(ctx, p);
      const matched = badge.present ? matchModule(badge.sig) : null;
      const bonus = await readBonus(ctx, p);
      const level = await readLevel(ctx, p);
      const plate = crop(full, p.cx - 0.5 * p.w, p.cy - 0.5 * p.w, p.cx + 0.5 * p.w, p.cy + 0.5 * p.w);
      slots.push({
        slot: i + 1,
        type: cls.name, type_key: cls.key, type_score: cls.score,
        level, bonus,
        side: badge.side,
        badge_present: badge.present,
        badge_img: badge.thumb,
        sig: badge.sig,
        module: matched ? matched.module : '',
        module_conf: matched ? (1 - matched.dist) : 0,
        plate: plate ? shrink(plate.canvas, 96).toDataURL('image/jpeg', 0.75) : null
      });
    }
    return { ok: true, slots, note: '识别出 ' + slots.length + ' 件，确认后入库' };
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  return { recognize, ensureWorker, setTemplates, matchModule, b64, _unb64: unb64, _test: { findPlates, detectPlates, sigAlign, gradSig, ocr, voteNumber, stretch, findTealPill, findDigitRun, crop, classify, readBonus, readLevel, readBadge, sigDistance, toHSV } };
})();
