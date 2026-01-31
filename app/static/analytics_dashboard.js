(() => {
  const DASH_ROOT_ID = 'analyticsDashboard';
  const BOOT_ID = 'analyticsBoot';
  const AUTO_BTN_ID = 'analyticsAutoRefreshBtn';
  const AUTO_LABEL_ID = 'analyticsAutoRefreshLabel';
  const AUTO_KEY = 'vs_analytics_auto_refresh';
  const AUTO_INTERVAL_MS = 15000;

  const state = {
    root: null,
    charts: new Map(),
    echartsPromise: null,
    autoTimer: null,
    resizeHandler: null,
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtLocalTime(iso) {
    try {
      const d = iso ? new Date(iso) : new Date();
      if (!Number.isFinite(d.getTime())) return '—';
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    } catch {
      return '—';
    }
  }

  function fmtInt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n ?? '');
    return Math.round(v).toLocaleString();
  }

  function fmtPct(p) {
    const v = Number(p);
    if (!Number.isFinite(v)) return String(p ?? '');
    return `${(v * 100).toFixed(1)}%`;
  }

  function fmtMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v)) return String(ms ?? '');
    return `${Math.round(v)}ms`;
  }

  function parseBootData(root) {
    const boot = root.querySelector(`#${BOOT_ID}`);
    if (!boot) return null;
    try {
      const txt = boot.textContent || '';
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  function loadECharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (state.echartsPromise) return state.echartsPromise;

    state.echartsPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-echarts="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.echarts), { once: true });
        existing.addEventListener('error', () => reject(new Error('echarts load failed')), { once: true });
        return;
      }

      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';
      s.async = true;
      s.dataset.echarts = '1';
      s.onload = () => resolve(window.echarts);
      s.onerror = () => reject(new Error('echarts load failed'));
      document.head.appendChild(s);
    });

    return state.echartsPromise;
  }

  function disposeCharts() {
    for (const ch of state.charts.values()) {
      try {
        ch.dispose();
      } catch {}
    }
    state.charts.clear();
    if (state.resizeHandler) {
      window.removeEventListener('resize', state.resizeHandler);
      state.resizeHandler = null;
    }
  }

  function ensureChart(el) {
    if (!window.echarts) return null;
    const prev = state.charts.get(el);
    if (prev) return prev;
    try {
      const ch = window.echarts.init(el, null, { renderer: 'canvas' });
      state.charts.set(el, ch);
      return ch;
    } catch {
      return null;
    }
  }

  function chartTextFallback(el, text) {
    if (!el) return;
    el.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'muted';
    d.style.padding = '10px 2px';
    d.textContent = text;
    el.appendChild(d);
  }

  function applyChartStyle(opt) {
    return {
      backgroundColor: 'transparent',
      textStyle: { color: '#f5f5f7', fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' },
      ...opt,
    };
  }

  function renderMetrics(root, data) {
    const ov = data?.overview || {};
    const keys = Object.keys(ov);
    keys.forEach((k) => {
      const card = root.querySelector(`[data-metric="${CSS.escape(k)}"]`);
      if (!card) return;
      const valEl = card.querySelector('[data-value]');
      const deltaEl = card.querySelector('[data-delta]');
      if (valEl) {
        const fmt = valEl.getAttribute('data-format') || '';
        const raw = ov?.[k]?.value;
        if (fmt === 'pct') valEl.textContent = fmtPct(raw);
        else if (fmt === 'ms') valEl.textContent = fmtMs(raw);
        else if (fmt === 'int') valEl.textContent = fmtInt(raw);
        else valEl.textContent = String(raw ?? '');
      }
      if (deltaEl) {
        deltaEl.textContent = String(ov?.[k]?.delta ?? '');
        deltaEl.classList.remove('trend-up', 'trend-down', 'trend-flat');
        const tr = ov?.[k]?.trend || 'flat';
        deltaEl.classList.add(`trend-${tr}`);
      }
    });

    const updated = root.querySelector('[data-analytics-updated]');
    if (updated) updated.textContent = `最后更新：${fmtLocalTime(data?.meta?.now)}`;
  }

  function renderActivity(root, data) {
    const wrap = root.querySelector('[data-analytics-activity]');
    if (!wrap) return;
    const items = Array.isArray(data?.activity) ? data.activity : [];
    wrap.innerHTML = '';
    items.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'analytics-activity-item';
      const top = document.createElement('div');
      top.className = 'analytics-activity-top';
      const user = document.createElement('div');
      user.className = 'analytics-activity-user';
      user.textContent = String(a?.username ?? '');
      const when = document.createElement('div');
      when.className = 'muted analytics-activity-when';
      when.textContent = String(a?.when ?? '');
      top.appendChild(user);
      top.appendChild(when);
      const line = document.createElement('div');
      line.className = 'analytics-activity-line';
      line.textContent = String(a?.line ?? '');
      item.appendChild(top);
      item.appendChild(line);
      const sub = String(a?.sub ?? '');
      if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'muted analytics-activity-sub';
        subEl.textContent = sub;
        item.appendChild(subEl);
      }
      wrap.appendChild(item);
    });
  }

  function renderRanking(root, data) {
    const wrap = root.querySelector('[data-analytics-ranking]');
    if (!wrap) return;
    const items = Array.isArray(data?.ranking) ? data.ranking : [];
    wrap.innerHTML = '';
    items.forEach((u) => {
      const item = document.createElement('div');
      item.className = 'analytics-rank-item';
      const left = document.createElement('div');
      left.className = 'analytics-rank-left';
      const name = document.createElement('div');
      name.className = 'analytics-rank-name';
      name.textContent = `${u?.rank ?? ''}. ${u?.username ?? ''}`.trim();
      const bar = document.createElement('div');
      bar.className = 'analytics-rank-bar';
      const fill = document.createElement('div');
      fill.className = 'analytics-rank-bar-fill';
      fill.style.width = `${Math.max(0, Math.min(100, Number(u?.bar ?? 0)))}%`;
      bar.appendChild(fill);
      left.appendChild(name);
      left.appendChild(bar);

      const right = document.createElement('div');
      right.className = 'analytics-rank-right mono';
      const st = document.createElement('span');
      st.className = 'analytics-rank-status';
      st.textContent = String(u?.status ?? '');
      const cnt = document.createElement('span');
      cnt.textContent = fmtInt(u?.count ?? 0);
      right.appendChild(st);
      right.appendChild(cnt);

      item.appendChild(left);
      item.appendChild(right);
      wrap.appendChild(item);
    });

    const onlineWrap = root.querySelector('[data-analytics-online]');
    if (!onlineWrap) return;
    const online = Array.isArray(data?.online) ? data.online : [];
    onlineWrap.innerHTML = '';
    online.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'analytics-online-item';
      const dot = document.createElement('span');
      dot.className = 'analytics-online-dot';
      dot.textContent = String(o?.status ?? '');
      const name = document.createElement('span');
      name.className = 'analytics-online-name';
      name.textContent = String(o?.username ?? '');
      const when = document.createElement('span');
      when.className = 'muted analytics-online-when';
      when.textContent = String(o?.last_seen ?? '');
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(when);
      onlineWrap.appendChild(row);
    });
  }

  function renderErrors(root, data) {
    const wrap = root.querySelector('[data-analytics-errors]');
    if (!wrap) return;
    const items = Array.isArray(data?.errors) ? data.errors : [];
    wrap.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'muted analytics-empty';
      empty.textContent = '最近没有错误事件';
      wrap.appendChild(empty);
      return;
    }

    items.forEach((e) => {
      const item = document.createElement('div');
      item.className = 'analytics-error-item';
      const top = document.createElement('div');
      top.className = 'analytics-error-top';
      const msg = document.createElement('div');
      msg.className = 'analytics-error-msg';
      msg.textContent = `⚠ ${String(e?.msg ?? '')}`.trim();
      const when = document.createElement('div');
      when.className = 'muted analytics-error-when';
      when.textContent = String(e?.when ?? '');
      top.appendChild(msg);
      top.appendChild(when);
      item.appendChild(top);
      const where = String(e?.where ?? '');
      if (where) {
        const w = document.createElement('div');
        w.className = 'muted analytics-error-where';
        w.textContent = where;
        item.appendChild(w);
      }
      wrap.appendChild(item);
    });
  }

  function renderSlow(root, data) {
    const wrap = root.querySelector('[data-analytics-slow]');
    if (!wrap) return;
    const items = Array.isArray(data?.performance?.slow) ? data.performance.slow : [];
    wrap.innerHTML = '';
    items.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'analytics-slow-item';
      const path = document.createElement('div');
      path.className = 'mono analytics-slow-path';
      path.textContent = String(s?.path ?? '');
      const meta = document.createElement('div');
      meta.className = 'muted analytics-slow-meta';
      meta.textContent = `avg ${fmtMs(s?.avg_ms ?? 0)} · p95 ${fmtMs(s?.p95_ms ?? 0)} · ${fmtInt(s?.count ?? 0)} 次`;
      item.appendChild(path);
      item.appendChild(meta);
      wrap.appendChild(item);
    });

    const kpi = root.querySelector('[data-analytics-perf-kpi]');
    if (kpi) {
      const p50 = fmtMs(data?.performance?.p50_ms ?? 0);
      const p95 = fmtMs(data?.performance?.p95_ms ?? 0);
      const p99 = fmtMs(data?.performance?.p99_ms ?? 0);
      kpi.textContent = `P50: ${p50} · P95: ${p95} · P99: ${p99}`;
    }
  }

  function renderEnv(root, data) {
    const env = data?.env || {};
    root.querySelectorAll('[data-analytics-env]').forEach((el) => {
      const key = el.getAttribute('data-analytics-env');
      const items = Array.isArray(env?.[key]) ? env[key] : [];
      el.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'muted';
        empty.style.fontSize = '13px';
        empty.textContent = '暂无数据';
        el.appendChild(empty);
        return;
      }
      items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'analytics-mini-row';
        const name = document.createElement('div');
        name.className = 'analytics-mini-name mono';
        name.textContent = String(it?.name ?? '');
        const bar = document.createElement('div');
        bar.className = 'analytics-mini-bar';
        const fill = document.createElement('div');
        fill.className = 'analytics-mini-fill';
        fill.style.width = `${Math.round(100 * Math.max(0, Math.min(1, Number(it?.pct ?? 0))))}%`;
        bar.appendChild(fill);
        const val = document.createElement('div');
        val.className = 'analytics-mini-val mono';
        val.textContent = fmtInt(it?.count ?? 0);
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(val);
        el.appendChild(row);
      });
    });
  }

  function renderRetentionTable(root, data) {
    const table = root.querySelector('[data-analytics-retention-table]');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const items = Array.isArray(data?.retention?.table) ? data.retention.table : [];
    tbody.innerHTML = '';
    items.forEach((r) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.className = 'mono';
      td0.textContent = String(r?.date ?? '');
      const tdSize = document.createElement('td');
      tdSize.className = 'mono';
      tdSize.textContent = fmtInt(r?.size ?? 0);

      const mk = (pct, avg) => {
        const td = document.createElement('td');
        td.className = 'analytics-heat-cell';
        if (pct == null) {
          td.textContent = '-';
          td.style.setProperty('--heat', '0');
          return td;
        }
        const p = Number(pct);
        const heat = Number.isFinite(p) ? Math.max(0, Math.min(1, p / 100)) : 0;
        td.style.setProperty('--heat', String(heat));

        const main = document.createElement('div');
        main.textContent = `${fmtInt(p)}%`;
        const sub = document.createElement('div');
        sub.className = 'muted analytics-heat-sub';
        const a = Number(avg);
        sub.textContent = Number.isFinite(a) ? `${a.toFixed(1)} 次/活跃人` : '-';

        td.appendChild(main);
        td.appendChild(sub);
        return td;
      };
      tr.appendChild(td0);
      tr.appendChild(tdSize);
      tr.appendChild(mk(r?.d1, r?.d1_avg));
      tr.appendChild(mk(r?.d3, r?.d3_avg));
      tr.appendChild(mk(r?.d7, r?.d7_avg));
      tr.appendChild(mk(r?.d14, r?.d14_avg));
      tr.appendChild(mk(r?.d30, r?.d30_avg));
      tbody.appendChild(tr);
    });
  }

  function renderFunnel(root, data) {
    const wrap = root.querySelector('[data-analytics-funnel]');
    if (!wrap) return;

    const funnel = data?.funnel || {};
    if (!funnel?.enabled) {
      wrap.innerHTML = '';
      return;
    }

    const modeKey = 'vs_analytics_funnel_mode';
    const saved = localStorage.getItem(modeKey);
    let mode = saved === 'events' ? 'events' : 'users';
    const setMode = (m) => {
      mode = m;
      localStorage.setItem(modeKey, mode);
      root.querySelectorAll('[data-analytics-funnel-mode]').forEach((b) => {
        const on = b.getAttribute('data-analytics-funnel-mode') === mode;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      render();
    };

    root.querySelectorAll('[data-analytics-funnel-mode]').forEach((b) => {
      const m = b.getAttribute('data-analytics-funnel-mode');
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
      b.onclick = () => setMode(m);
    });

    const render = () => {
      const rows = Array.isArray(funnel?.[mode]) ? funnel[mode] : [];
      wrap.innerHTML = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'muted analytics-empty';
        empty.textContent = '暂无数据';
        wrap.appendChild(empty);
        return;
      }

      rows.forEach((r, idx) => {
        const row = document.createElement('div');
        row.className = 'analytics-funnel-row';

        const name = document.createElement('div');
        name.className = 'analytics-funnel-name';
        name.textContent = String(r?.name ?? '');

        const bar = document.createElement('div');
        bar.className = 'analytics-funnel-bar';
        const fill = document.createElement('div');
        fill.className = 'analytics-funnel-fill';
        const w = Number(r?.width ?? 0);
        fill.style.setProperty('--w', String(Math.max(0, Math.min(1, Number.isFinite(w) ? w : 0))));
        bar.appendChild(fill);

        const meta = document.createElement('div');
        meta.className = 'analytics-funnel-meta';
        const cnt = document.createElement('div');
        cnt.className = 'mono';
        cnt.textContent = fmtInt(r?.count ?? 0);
        meta.appendChild(cnt);

        if (idx > 0) {
          const conv = Number(r?.conv ?? 0);
          const drop = Number(r?.drop ?? 0);
          const s = document.createElement('span');
          s.className = 'muted';
          const convPct = Number.isFinite(conv) ? Math.round(conv * 100) : 0;
          const dropPct = Number.isFinite(drop) ? Math.round(drop * 100) : 0;
          s.textContent = `转化 ${convPct}% · 流失 ${dropPct}%`;
          meta.appendChild(s);
        } else {
          const s = document.createElement('span');
          s.className = 'muted';
          s.textContent = mode === 'users' ? '去重用户' : '事件次数';
          meta.appendChild(s);
        }

        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(meta);
        wrap.appendChild(row);
      });
    };

    render();
  }

  function renderCharts(root, data) {
    const charts = root.querySelectorAll('[data-chart]');
    if (!charts.length) return;

    loadECharts()
      .then(() => {
        charts.forEach((el) => {
          const type = el.getAttribute('data-chart');
          const ch = ensureChart(el);
          if (!ch) return;

          if (type === 'trend') {
            const labels = data?.trend?.labels || [];
            const values = data?.trend?.values || [];
            ch.setOption(
              applyChartStyle({
                grid: { left: 28, right: 18, top: 18, bottom: 24 },
                tooltip: { trigger: 'axis' },
                xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#3a3a3c' } }, axisLabel: { color: '#8e8e93' } },
                yAxis: { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                series: [
                  {
                    type: 'line',
                    data: values,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2, color: '#d4662c' },
                    areaStyle: { color: 'rgba(212,102,44,0.18)' },
                  },
                ],
              })
            );
            return;
          }

          if (type === 'hours') {
            const labels = data?.hours?.labels || [];
            const values = data?.hours?.values || [];
            ch.setOption(
              applyChartStyle({
                grid: { left: 28, right: 18, top: 18, bottom: 30 },
                tooltip: { trigger: 'axis' },
                xAxis: {
                  type: 'category',
                  data: labels,
                  axisLine: { lineStyle: { color: '#3a3a3c' } },
                  axisLabel: { color: '#8e8e93', interval: 3 },
                },
                yAxis: { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                series: [{ type: 'bar', data: values, itemStyle: { color: 'rgba(212,102,44,0.75)', borderRadius: [6, 6, 0, 0] } }],
              })
            );
            return;
          }

          if (type === 'ratings') {
            const items = Array.isArray(data?.learning?.ratings) ? data.learning.ratings : [];
            ch.setOption(
              applyChartStyle({
                tooltip: { trigger: 'item' },
                color: ['#c44', '#c48a2a', 'rgba(245,245,247,0.65)', '#5a8c6a'],
                legend: {
                  bottom: 0,
                  left: 'center',
                  itemWidth: 12,
                  itemHeight: 8,
                  textStyle: { color: '#8e8e93', fontSize: 12 },
                },
                series: [
                  {
                    type: 'pie',
                    center: ['50%', '46%'],
                    radius: ['44%', '68%'],
                    avoidLabelOverlap: true,
                    itemStyle: { borderColor: 'rgba(44,44,46,0.78)', borderWidth: 2 },
                    label: { show: false },
                    labelLine: { show: false },
                    data: items.map((it) => ({ name: it.label, value: it.count })),
                  },
                ],
              })
            );
            return;
          }

          if (type === 'time') {
            const items = Array.isArray(data?.learning?.time) ? data.learning.time : [];
            ch.setOption(
              applyChartStyle({
                grid: { left: 28, right: 18, top: 18, bottom: 30 },
                tooltip: { trigger: 'axis' },
                xAxis: { type: 'category', data: items.map((i) => i.label), axisLabel: { color: '#8e8e93' }, axisLine: { lineStyle: { color: '#3a3a3c' } } },
                yAxis: { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                series: [
                  {
                    type: 'bar',
                    data: items.map((i) => i.count),
                    barMaxWidth: 28,
                    itemStyle: { color: 'rgba(245,245,247,0.65)', borderRadius: [6, 6, 0, 0] },
                  },
                ],
              })
            );
            return;
          }

          if (type === 'funnel') {
            const items = Array.isArray(data?.funnel) ? data.funnel : [];
            if (!items.length) {
              chartTextFallback(el, '暂无数据');
              return;
            }
            ch.setOption(
              applyChartStyle({
                tooltip: { trigger: 'item' },
                series: [
                  {
                    type: 'funnel',
                    left: '6%',
                    top: 10,
                    bottom: 10,
                    width: '88%',
                    minSize: '0%',
                    maxSize: '100%',
                    sort: 'none',
                    gap: 2,
                    label: { color: '#f5f5f7' },
                    itemStyle: { borderColor: 'rgba(44,44,46,0.78)', borderWidth: 2 },
                    data: items.map((i) => ({ name: i.name, value: i.value })),
                  },
                ],
              })
            );
            return;
          }

          if (type === 'retention') {
            const items = Array.isArray(data?.retention?.curve) ? data.retention.curve : [];
            ch.setOption(
              applyChartStyle({
                grid: { left: 28, right: 28, top: 22, bottom: 24 },
                tooltip: { trigger: 'axis' },
                legend: { top: 0, right: 0, textStyle: { color: '#8e8e93', fontSize: 12 } },
                xAxis: { type: 'category', data: items.map((i) => i.day), axisLabel: { color: '#8e8e93' }, axisLine: { lineStyle: { color: '#3a3a3c' } } },
                yAxis: [
                  { type: 'value', axisLabel: { color: '#8e8e93', formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                  { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { show: false } },
                ],
                series: [
                  {
                    name: '留存%',
                    type: 'line',
                    data: items.map((i) => Math.round(1000 * Number(i.pct || 0)) / 10),
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: { width: 2, color: '#d4662c' },
                    itemStyle: { color: '#d4662c' },
                  },
                  {
                    name: '次/活跃人',
                    type: 'bar',
                    yAxisIndex: 1,
                    data: items.map((i) => Math.round(10 * Number(i.avg_events || 0)) / 10),
                    barMaxWidth: 22,
                    itemStyle: { color: 'rgba(245,245,247,0.30)', borderRadius: [6, 6, 0, 0] },
                  },
                ],
              })
            );
            return;
          }

          if (type === 'pages') {
            const items = Array.isArray(data?.pages) ? data.pages : [];
            const names = items.map((i) => i.path);
            const vals = items.map((i) => i.count);
            ch.setOption(
              applyChartStyle({
                grid: { left: 120, right: 18, top: 18, bottom: 18 },
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                xAxis: { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                yAxis: {
                  type: 'category',
                  data: names.reverse(),
                  axisLabel: {
                    color: '#8e8e93',
                    formatter: (v) => {
                      const s = String(v ?? '');
                      return s.length > 18 ? `${s.slice(0, 18)}…` : s;
                    },
                  },
                  axisLine: { lineStyle: { color: '#3a3a3c' } },
                },
                series: [{ type: 'bar', data: vals.reverse(), itemStyle: { color: 'rgba(245,245,247,0.65)', borderRadius: [0, 8, 8, 0] } }],
              })
            );
            return;
          }

          if (type === 'perf') {
            const labels = data?.performance?.series?.labels || [];
            const values = data?.performance?.series?.values || [];
            ch.setOption(
              applyChartStyle({
                grid: { left: 28, right: 18, top: 18, bottom: 24 },
                tooltip: { trigger: 'axis' },
                xAxis: { type: 'category', data: labels, axisLabel: { color: '#8e8e93' }, axisLine: { lineStyle: { color: '#3a3a3c' } } },
                yAxis: { type: 'value', axisLabel: { color: '#8e8e93' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
                series: [
                  {
                    type: 'line',
                    data: values,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2, color: 'rgba(245,245,247,0.7)' },
                    areaStyle: { color: 'rgba(245,245,247,0.10)' },
                  },
                ],
              })
            );
          }
        });

        if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
        state.resizeHandler = () => {
          state.charts.forEach((ch) => {
            try {
              ch.resize();
            } catch {}
          });
        };
        window.addEventListener('resize', state.resizeHandler);
      })
      .catch(() => {
        charts.forEach((el) => chartTextFallback(el, '图表加载失败（离线或被拦截）'));
      });
  }

  async function fetchDashboard(days) {
    const qs = new URLSearchParams({ days: String(days || 7) });
    const resp = await fetch(`/api/analytics/dashboard?${qs.toString()}`, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    return await resp.json();
  }

  function getSelectedDays(root, data) {
    const sel = root.querySelector('select[name="days"]');
    const raw = sel ? sel.value : null;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    return Number(data?.meta?.days || 7);
  }

  function setAutoRefreshUI(on) {
    const btn = document.getElementById(AUTO_BTN_ID);
    const label = document.getElementById(AUTO_LABEL_ID);
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (label) label.classList.toggle('with-hint-dot', on);
  }

  function stopAutoRefresh() {
    if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  }

  function startAutoRefresh(root) {
    stopAutoRefresh();
    state.autoTimer = setInterval(async () => {
      try {
        const days = getSelectedDays(root, null);
        const data = await fetchDashboard(days);
        renderAll(root, data);
      } catch {}
    }, AUTO_INTERVAL_MS);
  }

  function renderAll(root, data) {
    renderMetrics(root, data);
    renderActivity(root, data);
    renderRanking(root, data);
    renderErrors(root, data);
    renderSlow(root, data);
    renderEnv(root, data);
    renderRetentionTable(root, data);
    renderFunnel(root, data);
    renderCharts(root, data);
  }

  function bindAutoRefresh(root, boot) {
    const btn = document.getElementById(AUTO_BTN_ID);
    if (!btn) return;

    const saved = localStorage.getItem(AUTO_KEY);
    let on = saved === '1';
    setAutoRefreshUI(on);
    if (on) startAutoRefresh(root);

    btn.onclick = async () => {
      on = !on;
      localStorage.setItem(AUTO_KEY, on ? '1' : '0');
      setAutoRefreshUI(on);
      if (on) {
        startAutoRefresh(root);
        try {
          const days = getSelectedDays(root, boot);
          const data = await fetchDashboard(days);
          renderAll(root, data);
        } catch {}
      } else {
        stopAutoRefresh();
      }
    };
  }

  function init() {
    const root = document.getElementById(DASH_ROOT_ID);
    if (!root) {
      if (state.root) {
        state.root = null;
        stopAutoRefresh();
        disposeCharts();
      }
      return;
    }

    if (state.root && state.root !== root) {
      stopAutoRefresh();
      disposeCharts();
    }
    state.root = root;

    const boot = parseBootData(root);
    if (!boot) return;

    bindAutoRefresh(root, boot);
    renderAll(root, boot);
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('htmx:afterSwap', (e) => {
    const target = e?.detail?.target;
    if (target && target.id === 'content') init();
  });
})();
