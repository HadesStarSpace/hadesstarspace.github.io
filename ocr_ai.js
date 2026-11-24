/* AI 文字识别（在浏览器里跑 PP-OCRv4 onnx）：分辨率无关，模型只下载一次 */
(function () {
  /* 模型优先走 jsDelivr（快、有缓存），失败再回退到本站同源 */
  const BASES = [
    'https://raw.githubusercontent.com/HadesStarSpace/qs-exchange/main/models/',
    'https://cdn.jsdelivr.net/gh/HadesStarSpace/qs-exchange@main/models/',
    'models/'
  ];
  const DET_NAME = 'ch_PP-OCRv4_det_infer.onnx';
  const REC_NAME = 'ch_PP-OCRv4_rec_infer.onnx';
  const CHARSET_NAME = 'charset.txt';
  const LIMIT = 736, THRESH = 0.3, BOX_THRESH = 0.5, UNCLIP = 1.6, REC_H = 48;

  let det = null, rec = null, chars = null;
  let loading = null;

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  async function fetchText(name) {
    let last;
    for (const b of BASES) {
      try {
        const r = await fetch(b + name);
        if (!r.ok) throw new Error(r.status);
        return await r.text();
      } catch (e) { last = e; }
    }
    throw last || new Error('下载失败：' + name);
  }

  async function fetchBin(name, onProg) {
    let last;
    for (let bi = 0; bi < BASES.length; bi++) {
      try {
        const r = await fetch(BASES[bi] + name);
        if (!r.ok) throw new Error(r.status);
        const total = +(r.headers.get('content-length') || 0);
        if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
        const rd = r.body.getReader(); const chunks = []; let got = 0;
        while (true) {
          const { done, value } = await rd.read();
          if (done) break;
          chunks.push(value); got += value.length;
          if (onProg) onProg(got, total);
        }
        const out = new Uint8Array(got); let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      } catch (e) { last = e; }
    }
    throw last || new Error('下载失败：' + name);
  }

  async function loadCharset() {
    if (chars) return chars;
    const t = await fetchText(CHARSET_NAME);
    chars = t.split('\n');
    while (chars.length && chars[chars.length - 1] === '') chars.pop();
    return chars;
  }

  async function load(onProg) {
    if (rec && det) return;
    if (loading) return loading;
    loading = (async () => {
      if (typeof ort === 'undefined') throw new Error('ort 未加载');
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
      ort.env.wasm.numThreads = 1;
      await loadCharset();
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const d = await fetchBin(DET_NAME, (g, t) => onProg && onProg('下载检测模型', g, t));
      det = await ort.InferenceSession.create(d, opt);
      const r = await fetchBin(REC_NAME, (g, t) => onProg && onProg('下载识别模型', g, t));
      rec = await ort.InferenceSession.create(r, opt);
    })();
    return loading;
  }

  /* ---------- 检测：缩放到短边 736、补到 32 的倍数、归一化 ---------- */
  function detInput(bmp, maxSide) {
    const w = bmp.width, h = bmp.height;
    let ratio = Math.min(w, h) < LIMIT ? LIMIT / Math.min(w, h) : 1;
    // 大图默认限到长边 maxSide（快）；容器版式会再跑一遍全分辨率（准）
    const MAX_SIDE = maxSide || 1920;
    if (Math.max(w, h) * ratio > MAX_SIDE) ratio = MAX_SIDE / Math.max(w, h);
    let nh = Math.max(32, Math.round(h * ratio)), nw = Math.max(32, Math.round(w * ratio));
    const ph = (32 - (nh % 32)) % 32, pw = (32 - (nw % 32)) % 32;
    nh += ph; nw += pw;
    const c = canvasOf(nw, nh), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, nw, nh);
    g.drawImage(bmp, 0, 0, w, h, 0, 0, Math.round(w * ratio), Math.round(h * ratio));
    const px = g.getImageData(0, 0, nw, nh).data;
    const data = new Float32Array(3 * nw * nh);
    const plane = nw * nh;
    for (let i = 0, k = 0; i < plane; i++, k += 4) {
      data[i] = px[k] / 127.5 - 1;
      data[plane + i] = px[k + 1] / 127.5 - 1;
      data[2 * plane + i] = px[k + 2] / 127.5 - 1;
    }
    return { data, nw, nh, ratio };
  }

  function boxesFromProb(prob, nw, nh, ratio) {
    const mask = new Uint8Array(nw * nh);
    for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > THRESH ? 1 : 0;
    const seen = new Uint8Array(nw * nh);
    const out = [];
    const stack = [];
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i0 = y * nw + x;
        if (!mask[i0] || seen[i0]) continue;
        let x0 = x, x1 = x, y0 = y, y1 = y, sum = 0, cnt = 0, mx = 0;
        stack.length = 0; stack.push(i0); seen[i0] = 1;
        while (stack.length) {
          const p = stack.pop();
          const py = Math.floor(p / nw), px2 = p % nw;
          sum += prob[p]; cnt++; if (prob[p] > mx) mx = prob[p];
          if (px2 < x0) x0 = px2; if (px2 > x1) x1 = px2;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          if (px2 > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
          if (px2 + 1 < nw && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
          if (py > 0 && mask[p - nw] && !seen[p - nw]) { seen[p - nw] = 1; stack.push(p - nw); }
          if (py + 1 < nh && mask[p + nw] && !seen[p + nw]) { seen[p + nw] = 1; stack.push(p + nw); }
        }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        if (bw < 6 || bh < 5) continue;
        const score = Math.max(mx, sum / Math.max(1, cnt));
        if (score < BOX_THRESH) continue;
        const d = (bw * bh) * UNCLIP / (2 * (bw + bh));
        out.push({
          x0: Math.max(0, Math.floor((x0 - d) / ratio)), y0: Math.max(0, Math.floor((y0 - d) / ratio)),
          x1: Math.ceil((x1 + d) / ratio), y1: Math.ceil((y1 + d) / ratio), score
        });
      }
    }
    return out;
  }

  /* ---------- 识别：裁条 → 高 48 → CTC 解码 ---------- */
  function recInput(bmp, b) {
    const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
    let rw = Math.max(8, Math.round(bw * REC_H / bh));
    rw = Math.max(32, Math.ceil(rw / 32) * 32);
    const c = canvasOf(rw, REC_H), g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, rw, REC_H);
    g.drawImage(bmp, b.x0, b.y0, bw, bh, 0, 0, Math.round(bw * REC_H / bh), REC_H);
    const px = g.getImageData(0, 0, rw, REC_H).data;
    const plane = rw * REC_H, data = new Float32Array(3 * plane);
    for (let i = 0, k = 0; i < plane; i++, k += 4) {
      data[i] = px[k] / 127.5 - 1;
      data[plane + i] = px[k + 1] / 127.5 - 1;
      data[2 * plane + i] = px[k + 2] / 127.5 - 1;
    }
    return { data, rw };
  }

  function decode(prob, T, C) {
    const code = chars;
    let prev = 0, text = '', acc = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bi = 0;
      for (let c = 0; c < C; c++) {
        const v = prob[t * C + c];
        if (v > best) { best = v; bi = c; }
      }
      if (bi !== prev && bi !== 0) {
        text += (bi - 1 >= code.length) ? ' ' : code[bi - 1];
        acc += best; n++;
      }
      prev = bi;
    }
    return { text, score: n ? acc / n : 0 };
  }

  async function recognizeBitmap(bmp, maxSide) {
    await load();
    const { data, nw, nh, ratio } = detInput(bmp, maxSide);
    const feeds = {};
    feeds[det.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, nh, nw]);
    const out = await det.run(feeds);
    const prob = out[det.outputNames[0]].data;
    const boxes = boxesFromProb(prob, nw, nh, ratio);
    const lines = [];
    for (const b of boxes) {
      const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
      if (bw * bh > 4000 * 400) continue;           // 整块背景不认
      const { data: rd, rw } = recInput(bmp, b);
      const rf = {};
      rf[rec.inputNames[0]] = new ort.Tensor('float32', rd, [1, 3, REC_H, rw]);
      const ro = await rec.run(rf);
      const t = ro[rec.outputNames[0]];
      const [T, C] = [t.dims[1], t.dims[2]];
      const { text, score } = decode(t.data, T, C);
      if (!text) continue;
      lines.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, score });
    }
    lines.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return lines;
  }

  /* 小区域放大后单独认一次：容器版式左下角「11」字号太小，整图检测常常漏 */
  async function ocrRegion(bmp, x0, y0, x1, y1, scale, binar) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(bmp.width, Math.round(x1)); y1 = Math.min(bmp.height, Math.round(y1));
    if (x1 - x0 < 10 || y1 - y0 < 10) return [];
    const sc = scale || 3;
    const c = canvasOf(Math.round((x1 - x0) * sc), Math.round((y1 - y0) * sc));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    if (binar) {
      // 白字（等级数字在白/薄荷底药丸里）拉成黑字白底，rec 才认得出
      const d = g.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = Math.max(0, Math.min(255, (lum - 135) * 255 / 115));
        const g2 = 255 - v;
        px[i] = px[i + 1] = px[i + 2] = g2; px[i + 3] = 255;
      }
      g.putImageData(d, 0, 0);
    }
    const bmp2 = await createImageBitmap(c);
    return await recognizeBitmap(bmp2, Math.max(bmp2.width, bmp2.height));
  }

  /* ---------- 从行里拼神器条目（规则与服务器端 ai_inbox.py 一致） ---------- */
  const TYPES = [['运输舰', 'trade'], ['武器', 'weapon'], ['战斗', 'weapon'], ['护盾', 'shield'],
    ['采矿', 'mining'], ['支援', 'support'], ['无人机', 'drone']];

  function parseItems(lines, bmp) {
    const names = lines.filter(l => l.text.includes('神器'));
    const levels = lines.filter(l => l.text.includes('等级'));
    const pills = lines.filter(l => /\d{3}\s*%/.test(l.text));
    const items = [];
    for (const nm of names) {
      const nh = nm.y1 - nm.y0;
      let lv = null, bn = null;
      for (const l of levels) {
        if (l.y0 > nm.y0 && l.y0 < nm.y0 + 3 * nh) { if (!lv || l.y0 < lv.y0) lv = l; }
      }
      for (const l of pills) {
        if (l.x0 > nm.x1 && l.y0 > nm.y0 && l.y0 < nm.y0 + 3 * nh) {
          if (!bn || Math.abs(((l.y0 + l.y1) / 2) - ((nm.y0 + nm.y1) / 2)) <
            Math.abs(((bn.y0 + bn.y1) / 2) - ((nm.y0 + nm.y1) / 2))) bn = l;
        }
      }
      const tkey = (TYPES.find(([kw]) => nm.text.includes(kw)) || [])[1] || null;
      let level = null, bonus = null;
      if (lv) { const m = lv.text.match(/(\d{1,2})/); if (m) level = +m[1]; }
      if (bn) { const m = bn.text.match(/(\d{3})/); if (m) { const v = +m[1]; if (v >= 280 && v <= 420) bonus = v; } }
      items.push({ type_key: tkey, level, bonus, name: nm, pill: bn, layout: 'list' });
    }
    if (items.length) return items;
    // ---- 文物容器版式：没有「XX神器」字样，只有 +360% 药丸 + 等级数字，按行列配对 ----
    const pills2 = pills.filter(l => l.x0 > bmp.width * 0.03);
    if (pills2.length < 2) return items;
    const nums = lines.filter(l => /^\s*\d{1,2}\s*$/.test(l.text) || /等级\s*\d{1,2}/.test(l.text));
    const cx = l => (l.x0 + l.x1) / 2, cy = l => (l.y0 + l.y1) / 2;
    for (const p of pills2) {
      const pw = p.x1 - p.x0, ph = p.y1 - p.y0;
      let lv = null;
      for (const n of nums) {
        if (n.y0 <= p.y0) continue;
        if (Math.abs(cx(n) - cx(p)) > 2.0 * pw) continue;
        if (cy(n) - cy(p) > 8.6 * ph) continue;
        if (!lv || cy(n) < cy(lv)) lv = n;
      }
      let level = null, bonus = null;
      const mb = p.text.match(/(\d{3})/);
      if (mb) { const v = +mb[1]; if (v >= 280 && v <= 420) bonus = v; }
      if (lv) { const m = lv.text.match(/(\d{1,2})/); if (m && +m[1] >= 5 && +m[1] <= 30) level = +m[1]; }
      if (bonus == null && level == null) continue;
      items.push({ type_key: null, level, bonus, name: null, pill: p, layout: 'grid' });
    }
    return items;
  }

  function cropCanvas(bmp, x0, y0, x1, y1, maxW) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(bmp.width, Math.round(x1)); y1 = Math.min(bmp.height, Math.round(y1));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const scale = maxW ? Math.min(1, maxW / (x1 - x0)) : 1;
    const c = canvasOf(Math.round((x1 - x0) * scale), Math.round((y1 - y0) * scale));
    c.getContext('2d').drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
    return c;
  }

  function itemVisual(bmp, it) {
    const pill = it.pill;
    let badge = null, card = null, side = '暗';
    if (pill) {
      const w = pill.x1 - pill.x0, h = pill.y1 - pill.y0;
      const cy = (pill.y0 + pill.y1) / 2;
      if (it.layout === 'grid') {
        // 容器版式：量子图标在药丸右下方，整块文物在它下面
        badge = cropCanvas(bmp, pill.x0 + 0.58 * w, pill.y1 + 0.30 * h, pill.x0 + 1.38 * w, pill.y1 + 1.75 * h, 48);
        card = cropCanvas(bmp, pill.x0 - 0.35 * w, pill.y0 - 0.2 * h, pill.x1 + 0.55 * w, pill.y1 + 7.4 * h, 96);
      } else {
        badge = cropCanvas(bmp, pill.x0 + 0.50 * w, cy - 3.2 * h, pill.x0 + 1.70 * w, cy - 0.7 * h, 48);
        card = cropCanvas(bmp, pill.x0 - 1.10 * w, cy - 3.6 * h, pill.x0 + 1.95 * w, cy + 0.35 * h, 96);
      }
      if (card) {
        const d = card.getContext('2d').getImageData(0, 0, card.width, card.height).data;
        let bright = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 690) bright++;
        if (bright / (d.length / 4) > 0.10) side = '光';
      }
    }
    return {
      plate: card ? card.toDataURL('image/jpeg', 0.8) : '',
      badge_img: badge ? badge.toDataURL('image/jpeg', 0.85) : '',
      lum: badge ? (() => {
        const d = badge.getContext('2d').getImageData(0, 0, badge.width, badge.height).data;
        let acc = 0;
        for (let i = 0; i < d.length; i += 4) acc += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return Math.round(acc / (d.length / 4));
      })() : null,
      sig: badge && REC._test.gradSig ? REC.b64(REC._test.gradSig(badge)) : '',
      badge_present: !!badge,
      side
    };
  }

  async function recognizeFile(file, onProgress) {
    await load();
    const bmp = await createImageBitmap(file);
    if (onProgress) onProgress('认字…');
    let lines = await recognizeBitmap(bmp, 1920);
    let items = parseItems(lines, bmp);
    // 容器版式：左下角等级字号太小，整图检测常漏 —— 按药丸位置裁小块、二值化后单独认
    if (items.length && items.every(i => i.layout === 'grid')) {
      for (const it of items) {
        if (it.level != null || !it.pill) continue;
        const p = it.pill, w = p.x1 - p.x0, h = p.y1 - p.y0;
        const lines2 = await ocrRegion(bmp, p.x0 - 0.55 * w, p.y1 + 4.8 * h, p.x1 + 0.3 * w, p.y1 + 7.4 * h, 3, true);
        for (const l of lines2) {
          const m = l.text.match(/(\d{1,2})/);
          if (m && +m[1] >= 5 && +m[1] <= 30) { it.level = +m[1]; break; }
        }
      }
    }
    if (onProgress) onProgress('拼条目…');
    return items.map(it => Object.assign({}, it, itemVisual(bmp, it), { name: undefined, pill: undefined }));
  }

  window.AIOCR = { load, recognizeFile, recognizeBitmap, ocrRegion, _test: { parseItems }, _warm: load };
})();
