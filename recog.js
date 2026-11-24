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
  function findPlates(imageData) {
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
      if (w < 45 || w > 110 || h < 45 || h > 110) continue;
      if (area < 1250 || area < 0.3 * w * h) continue;
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
  let worker = null, workerReady = null, ocrQueue = Promise.resolve();
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
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
    const thr = mode === 'fixed' ? 215 : otsu(gray);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const v = gray[i] > thr ? 255 : 0;
      d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  function ocr(canvas, psm, whitelist, mode) {
    ocrQueue = ocrQueue.then(async () => {
      const w = await ensureWorker();
      await w.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: whitelist || ''
      });
      const r = await w.recognize(prep(canvas, mode));
      return (r.data.text || '').replace(/\s+/g, '');
    });
    return ocrQueue.catch(() => '');
  }

  /* ---------- 识别单个槽位 ---------- */
  async function readBonus(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const regions = [
      [cx - 0.75 * W, cy - 2.05 * W, cx + 0.9 * W, cy - 1.02 * W],   // 文物容器：药丸在格子上方
      [cx + 0.10 * W, cy + 0.30 * W, cx + 1.30 * W, cy + 1.10 * W],   // 货物面板：药丸在右下
      [cx - 0.85 * W, cy + 0.25 * W, cx + 0.45 * W, cy + 1.05 * W]    // 列表/货物面板另一侧
    ];
    for (const box of regions) {
      const b = brightestBox(img, box, 900);
      let cc = null;
      if (b && b[2] / b[3] > 1.4 && b[2] / b[3] < 3.4) {
        cc = crop(img, b[0] - 3, b[1] - 3, b[0] + b[2] + 3, b[1] + b[3] + 3);
      } else {
        cc = crop(img, box[0], box[1], box[2], box[3]);
      }
      if (!cc) continue;
      // 内缩，去掉边框
      const inner = crop(cc.canvas, cc.w * 0.10, cc.h * 0.08, cc.w * 0.92, cc.h * 0.92);
      if (!inner) continue;
      for (const [psm, mode] of [[7, 'otsu'], [8, 'fixed'], [8, 'otsu']]) {
        const t = await ocr(inner.canvas, psm, '0123456789+%', mode);
        const digits = t.replace(/\D/g, '');
        if (digits.length >= 3) {
          const v = parseInt(digits.slice(0, 3), 10);
          if (v >= 100 && v <= 999) return v;
        }
      }
    }
    return null;
  }

  async function readLevel(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const box = [cx - 0.78 * W, cy + 0.86 * W, cx - 0.40 * W, cy + 1.30 * W];
    const cc = crop(img, box[0], box[1], box[2], box[3]);
    if (!cc) return null;
    for (const [psm, mode] of [[10, 'otsu'], [7, 'otsu'], [8, 'otsu']]) {
      const t = await ocr(cc.canvas, psm, '0123456789', mode);
      const digits = t.replace(/\D/g, '');
      if (digits.length >= 1) {
        const v = parseInt(digits.slice(0, 2), 10);
        if (v >= 8 && v <= 20) return v;
      }
    }
    // 其它版面（货物/列表）：格子左侧的一列文字，取 8~20 的数字
    const cc2 = crop(img, cx - 3.6 * W, cy - 0.7 * W, cx - 0.45 * W, cy + 0.7 * W);
    if (cc2) {
      const t = await ocr(cc2.canvas, 6, '0123456789', 'otsu');
      const nums = (t.match(/\d{1,2}/g) || []).map(x => parseInt(x, 10));
      const ok = nums.find(n => n >= 8 && n <= 20);
      if (ok) return ok;
    }
    return null;
  }

  function classify(img, p) {
    const W = p.w, H = p.h, cx = p.cx, cy = p.cy;
    const cc = crop(img, cx - 0.48 * W, cy - 0.48 * H, cx + 0.48 * W, cy + 0.48 * H);
    if (!cc) return { name: null, key: null, score: 9 };
    const d = cc.canvas.getContext('2d').getImageData(0, 0, cc.w, cc.h).data;
    const px = [];
    const hues = [];
    for (let i = 0, k = 0; i < cc.w * cc.h; i++, k += 4) {
      const hsv = toHSV(d[k], d[k + 1], d[k + 2]);
      if (hsv[1] > 70 && hsv[2] > 110) {
        px.push([d[k], d[k + 1], d[k + 2], hsv[1] * hsv[2]]);
        hues.push(hsv[0]);
      }
    }
    if (px.length < 20) return { name: null, key: null, score: 9 };
    px.sort((a, b) => a[3] - b[3]);
    const top = px.slice(Math.max(0, px.length - Math.max(40, Math.round(px.length * 0.25))));
    const med = i => {
      const v = top.map(t => t[i]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    const rgb = [med(0), med(1), med(2)];
    const ch = chroma(rgb);
    const hs = hues.slice().sort((a, b) => a - b);
    const hue = hs[Math.floor(hs.length / 2)];
    let best = null;
    for (const r of REFS) {
      const dh = Math.min(Math.abs(hue - r.hue), 180 - Math.abs(hue - r.hue)) / 90;
      const dc = Math.hypot(ch[0] - r.ref[0], ch[1] - r.ref[1], ch[2] - r.ref[2]);
      const score = dh * 1.2 + dc * 3.0;
      if (!best || score < best.score) best = { name: r.name, key: r.key, score };
    }
    return best;
  }

  function readBadge(img, p) {
    const W = p.w, cx = p.cx, cy = p.cy;
    const cc = crop(img, cx + 0.28 * W, cy - 1.26 * W, cx + 0.78 * W, cy - 0.80 * W);
    if (!cc) return { side: null, thumb: null };
    const g = grayOf(cc.canvas);
    let sum = 0; for (let i = 0; i < g.length; i++) sum += g[i];
    const mean = sum / g.length;
    const thumb = shrink(cc.canvas, 40);
    return { side: mean > 110 ? '光' : '暗', thumb: thumb.toDataURL('image/jpeg', 0.8), mean };
  }

  function shrink(canvas, size) {
    const s = size / Math.max(canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s));
    c.height = Math.max(1, Math.round(canvas.height * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------- 主流程 ---------- */
  async function recognize(file, onProgress) {
    const img = await loadImage(file);
    const full = document.createElement('canvas');
    full.width = img.width; full.height = img.height;
    full.getContext('2d').drawImage(img, 0, 0);
    const ctx = { canvas: full, width: img.width, height: img.height };
    const imgData = { canvas: full, width: img.width, height: img.height, data: full.getContext('2d').getImageData(0, 0, img.width, img.height).data };
    const plates = findPlates(imgData);
    if (plates.length < 1) return { ok: false, note: '没找到神器格子，请上传「文物容器」面板的完整截图' };
    const slots = [];
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      if (onProgress) onProgress(i, plates.length);
      const cls = classify(ctx, p);
      const badge = readBadge(ctx, p);
      const bonus = await readBonus(ctx, p);
      const level = await readLevel(ctx, p);
      const plate = crop(full, p.cx - 0.5 * p.w, p.cy - 0.5 * p.w, p.cx + 0.5 * p.w, p.cy + 0.5 * p.w);
      slots.push({
        slot: i + 1,
        type: cls.name, type_key: cls.key, type_score: cls.score,
        level, bonus,
        side: badge.side,
        badge_img: badge.thumb,
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

  return { recognize, ensureWorker, _test: { findPlates, classify, readBonus, readLevel, readBadge, toHSV } };
})();
