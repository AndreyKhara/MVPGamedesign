/*
 * UI: вкладки, импорт, редактор таблицы, TTK, прогрессия, лут, аудит, инфляция.
 * Расчёты — в formulas.js, разбор/валидация файлов — в data.js.
 */
(function () {
  'use strict';
  const F = window.Formulas, D = window.Data;
  const $ = id => document.getElementById(id);
  const STORE_KEY = 'bps.v1';

  // ---------- Состояние и сохранение ----------
  const defaults = {
    units: [], loot: [],
    columns: { units: D.SCHEMAS.units.required.slice(), loot: D.SCHEMAS.loot.required.concat('rarity') },
    ttk: { mult: 1, minRatio: 0.1, crit: 0, critMult: 2, attacker: null, target: null },
    progression: { a: 100, b: 1.5, c: 0, maxLevel: 30, statBase: 100, statGrowth: 0.08 },
    inflation: { start: 1000, income: 500, incomeGrowth: 0.03, sinkFixed: 300, sinkPercent: 0.05, steps: 50 },
    lootTol: 0.01, auditK: 1, tab: 'import', theme: null,
  };
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return Object.assign({}, structuredClone(defaults), s, {
          columns: Object.assign({}, defaults.columns, s.columns),
          ttk: Object.assign({}, defaults.ttk, s.ttk),
          progression: Object.assign({}, defaults.progression, s.progression),
          inflation: Object.assign({}, defaults.inflation, s.inflation),
        });
      }
    } catch (e) { console.warn('Не удалось прочитать сохранение', e); }
    return structuredClone(defaults);
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
        const el = $('saveStatus');
        if (el) el.textContent = 'Сохранено в localStorage: ' + new Date().toLocaleTimeString();
      } catch (e) {
        toast('Ошибка сохранения: ' + e.message);
      }
    }, 250);
  }

  // ---------- Утилиты ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(v, d = 2) {
    if (v === Infinity) return '∞';
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return Number(v.toFixed(d)).toLocaleString('ru-RU', { maximumFractionDigits: d });
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2500);
  }
  function numVal(id) { const v = Number($(id).value); return isFinite(v) ? v : 0; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }
  function clean(rows) { return rows.map(r => { const o = {}; Object.keys(r).forEach(k => { if (!k.startsWith('__')) o[k] = r[k]; }); return o; }); }

  // Юниты, пригодные для расчётов (в редакторе можно временно ввести мусор — он подсвечивается и пропускается)
  function validUnits() {
    return state.units.filter(u => ['hp', 'attack', 'defense', 'cost'].every(k => typeof u[k] === 'number' && isFinite(u[k])) && u.hp > 0);
  }

  // ---------- Вкладки и тема ----------
  const TABS = ['import', 'table', 'ttk', 'progression', 'loot', 'audit', 'inflation'];
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    state.tab = name; save();
    renderTab(name);
  }
  function renderTab(name) {
    ({ import: () => {}, table: renderTable, ttk: renderTTK, progression: renderProgression,
      loot: renderLoot, audit: renderAudit, inflation: renderInflation })[name]();
  }
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function applyTheme() {
    const theme = state.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
  }
  function toggleTheme() {
    state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); save(); renderTab(state.tab);
  }
  $('themeToggle').addEventListener('click', toggleTheme);

  // ---------- 1. Импорт ----------
  const drop = $('dropZone');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; });
  $('loadSampleUnits').addEventListener('click', () => { $('importTarget').value = 'units'; importText(window.SAMPLES.units, 'units.csv'); });
  $('loadSampleLoot').addEventListener('click', () => { $('importTarget').value = 'loot'; importText(window.SAMPLES.loot, 'loot.csv'); });

  function readFile(file) {
    if (file.size > 5 * 1024 * 1024) return showImportResult('bad', `Файл «${esc(file.name)}» больше 5 МБ`);
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result), file.name);
    reader.onerror = () => showImportResult('bad', 'Не удалось прочитать файл');
    reader.readAsText(file, 'utf-8');
  }

  function importText(text, filename) {
    const target = $('importTarget').value;
    const isJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);
    let parsed;
    try {
      parsed = isJson ? D.parseJSON(text) : D.parseCSV(text);
    } catch (e) {
      return showImportResult('bad', `Ошибка разбора «${esc(filename)}»: ${esc(e.message)}`);
    }
    // Подсказка, если перепутан набор данных
    const other = target === 'units' ? 'loot' : 'units';
    const res = D.validate(parsed, target);
    if (res.errors.length) {
      const hint = D.SCHEMAS[other].required.every(c => parsed.header.includes(c))
        ? `<p>Похоже, это файл набора «${D.SCHEMAS[other].title}» — выберите его в списке выше.</p>` : '';
      return showImportResult('bad',
        `Файл «${esc(filename)}» не импортирован, найдено ошибок: ${res.errors.length}.${hint}<ul>` +
        res.errors.slice(0, 100).map(e => `<li>Строка ${e.line}${e.col ? ', колонка ' + esc(e.col) : ''}: ${esc(e.msg)}</li>`).join('') +
        (res.errors.length > 100 ? '<li>…</li>' : '') + '</ul>');
    }
    let rows = res.rows;
    if ($('importMode').value === 'append') {
      const ids = new Set(state[target].map(r => String(r.id)));
      const dup = rows.filter(r => ids.has(String(r.id)));
      if (dup.length) return showImportResult('bad', `Нельзя добавить: ID уже есть в текущих данных — ${dup.map(r => esc(r.id)).join(', ')}`);
      rows = state[target].concat(rows);
    }
    state[target] = rows;
    // колонки: сначала известные из схемы, затем остальные в порядке файла
    const cols = D.collectColumns(rows);
    const schema = D.SCHEMAS[target];
    state.columns[target] = schema.required.concat(schema.optional.filter(c => cols.includes(c)), cols.filter(c => !schema.required.includes(c) && !schema.optional.includes(c)));
    save();
    const warn = res.warnings.length ? `<ul>${res.warnings.map(w => `<li>Строка ${w.line}: ${esc(w.msg)}</li>`).join('')}</ul>` : '';
    showImportResult(res.warnings.length ? 'warn' : 'ok',
      `Файл «${esc(filename)}» импортирован в набор «${schema.title}». Новых строк: ${res.rows.length}, всего: ${rows.length}.${warn}`);
    renderPreview(target);
  }

  function showImportResult(kind, html) {
    $('importResult').innerHTML = `<div class="msg ${kind}">${html}</div>`;
  }
  function renderPreview(target) {
    const cols = state.columns[target], rows = state[target].slice(0, 10);
    $('importResult').insertAdjacentHTML('beforeend',
      `<p class="muted">Первые ${rows.length} строк (редактирование — во вкладке «Таблица»):</p><div class="table-wrap"><table class="grid"><thead><tr>` +
      cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + cols.map(c => `<td>${esc(r[c])}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
  }

  // ---------- 2. Редактор таблицы ----------
  $('tableTarget').addEventListener('change', renderTable);
  $('tableFilter').addEventListener('input', renderTable);
  $('addRow').addEventListener('click', addRow);
  $('addColumn').addEventListener('click', () => {
    const target = $('tableTarget').value;
    const name = (prompt('Название новой колонки (латиница, без пробелов):') || '').trim().toLowerCase();
    if (!name) return;
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return toast('Недопустимое имя колонки');
    if (state.columns[target].includes(name)) return toast('Такая колонка уже есть');
    state.columns[target].push(name);
    state[target].forEach(r => (r[name] = ''));
    save(); renderTable();
  });
  $('clearTable').addEventListener('click', () => {
    const target = $('tableTarget').value;
    if (!confirm(`Удалить все строки набора «${D.SCHEMAS[target].title}»?`)) return;
    state[target] = []; save(); renderTable();
  });
  $('exportTableCsv').addEventListener('click', () => exportSet($('tableTarget').value, 'csv'));
  $('exportTableJson').addEventListener('click', () => exportSet($('tableTarget').value, 'json'));

  function exportSet(target, format) {
    const rows = clean(state[target]);
    if (!rows.length) return toast('Нет данных для экспорта');
    if (format === 'csv') D.download(`${target}_${stamp()}.csv`, D.toCSV(rows, state.columns[target]), 'text/csv;charset=utf-8');
    else D.download(`${target}_${stamp()}.json`, JSON.stringify(rows, null, 2), 'application/json');
  }

  function addRow() {
    const target = $('tableTarget').value;
    const ids = state[target].map(r => Number(r.id)).filter(isFinite);
    const row = {};
    state.columns[target].forEach(c => (row[c] = ''));
    row.id = String(ids.length ? Math.max(...ids) + 1 : 1);
    if (target === 'units') Object.assign(row, { name: 'Новый юнит', hp: 100, attack: 10, defense: 0, cost: 100 });
    else Object.assign(row, { table_id: 'default', item: 'Новый предмет', chance: 0 });
    state[target].push(row);
    save(); renderTable();
    const cells = $('editTable').querySelectorAll('tbody tr:last-child td[contenteditable]');
    if (cells[1]) cells[1].focus();
  }

  function cellProblem(target, col, value, rowIndex) {
    const s = D.SCHEMAS[target];
    if (s.required.includes(col) && (value === '' || value == null)) return 'обязательное поле';
    if (s.numeric.includes(col) && value !== '' && value != null) {
      if (typeof value !== 'number' || !isFinite(value)) return 'должно быть числом';
      const [lo, hi] = s.ranges[col] || [-Infinity, Infinity];
      if (value < lo || value > hi) return `вне диапазона [${lo}; ${hi}]`;
    }
    if (col === 'id') {
      const dup = state[target].some((r, i) => i !== rowIndex && String(r.id) === String(value));
      if (dup) return 'дубль ID';
    }
    return null;
  }

  function renderTable() {
    const target = $('tableTarget').value;
    const cols = state.columns[target];
    const s = D.SCHEMAS[target];
    const q = $('tableFilter').value.trim().toLowerCase();
    const t = $('editTable');
    if (!state[target].length) {
      t.innerHTML = '<tbody><tr><td class="muted">Нет данных. Импортируйте файл или нажмите «+ Строка».</td></tr></tbody>';
      return;
    }
    let html = '<thead><tr><th>#</th>' + cols.map(c => {
      const removable = !s.required.includes(c);
      return `<th class="${s.numeric.includes(c) ? 'num' : ''}">${esc(c)}${removable ? ` <button class="del" data-delcol="${esc(c)}" title="Удалить колонку">×</button>` : ''}</th>`;
    }).join('') + '<th></th></tr></thead><tbody>';
    state[target].forEach((r, i) => {
      if (q && !cols.some(c => String(r[c]).toLowerCase().includes(q))) return;
      html += `<tr data-i="${i}"><td class="muted">${i + 1}</td>` + cols.map(c => {
        const p = cellProblem(target, c, r[c], i);
        return `<td contenteditable="true" spellcheck="false" data-col="${esc(c)}" class="${s.numeric.includes(c) ? 'num' : ''}${p ? ' invalid' : ''}" title="${p ? esc(p) : ''}">${esc(r[c])}</td>`;
      }).join('') + `<td><button class="del" data-delrow="${i}" title="Удалить строку">🗑</button></td></tr>`;
    });
    t.innerHTML = html + '</tbody>';
  }

  $('editTable').addEventListener('input', e => {
    const td = e.target.closest('td[data-col]');
    if (!td) return;
    const target = $('tableTarget').value;
    const i = Number(td.parentElement.dataset.i), col = td.dataset.col;
    const raw = td.textContent.trim();
    const isNum = D.SCHEMAS[target].numeric.includes(col);
    const n = Number(raw.replace(',', '.'));
    state[target][i][col] = isNum && raw !== '' && isFinite(n) ? n : raw;
    const p = cellProblem(target, col, state[target][i][col], i);
    td.classList.toggle('invalid', !!p);
    td.title = p || '';
    save();
  });
  $('editTable').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('td[contenteditable]')) { e.preventDefault(); e.target.blur(); }
  });
  // после редактирования ID перерисовываем, чтобы обновить подсветку дублей во всех строках
  $('editTable').addEventListener('focusout', e => { if (e.target.dataset && e.target.dataset.col === 'id') renderTable(); });
  $('editTable').addEventListener('click', e => {
    const target = $('tableTarget').value;
    const del = e.target.closest('[data-delrow]');
    if (del) { state[target].splice(Number(del.dataset.delrow), 1); save(); renderTable(); return; }
    const dc = e.target.closest('[data-delcol]');
    if (dc && confirm(`Удалить колонку «${dc.dataset.delcol}»?`)) {
      const c = dc.dataset.delcol;
      state.columns[target] = state.columns[target].filter(x => x !== c);
      state[target].forEach(r => delete r[c]);
      save(); renderTable();
    }
  });

  // ---------- 3. TTK ----------
  ['ttkMult', 'ttkMinRatio', 'ttkCrit', 'ttkCritMult'].forEach(id => $(id).addEventListener('input', () => { readTTKOpts(); save(); renderTTK(); }));
  ['ttkAttacker', 'ttkTarget'].forEach(id => $(id).addEventListener('change', () => {
    state.ttk.attacker = $('ttkAttacker').value; state.ttk.target = $('ttkTarget').value; save(); renderTTKResult();
  }));
  $('exportTtk').addEventListener('click', () => {
    const units = validUnits(), o = ttkOpts();
    if (!units.length) return toast('Нет юнитов');
    const rows = units.map(a => {
      const r = { attacker: a.name };
      units.forEach(t => (r[t.name] = Number(F.computeTTK(a, t, o).ttkExpected.toFixed(3))));
      return r;
    });
    D.download(`ttk_matrix_${stamp()}.csv`, D.toCSV(rows), 'text/csv;charset=utf-8');
  });

  function ttkOpts() {
    return { multiplier: state.ttk.mult, minDamageRatio: state.ttk.minRatio, critChance: state.ttk.crit, critMult: state.ttk.critMult };
  }
  function readTTKOpts() {
    state.ttk.mult = numVal('ttkMult'); state.ttk.minRatio = numVal('ttkMinRatio');
    state.ttk.crit = Math.min(1, Math.max(0, numVal('ttkCrit'))); state.ttk.critMult = Math.max(1, numVal('ttkCritMult'));
  }

  function renderTTK() {
    $('ttkMult').value = state.ttk.mult; $('ttkMinRatio').value = state.ttk.minRatio;
    $('ttkCrit').value = state.ttk.crit; $('ttkCritMult').value = state.ttk.critMult;
    const units = validUnits();
    const opts = units.map(u => `<option value="${esc(u.id)}">${esc(u.name)} (#${esc(u.id)})</option>`).join('');
    $('ttkAttacker').innerHTML = opts; $('ttkTarget').innerHTML = opts;
    if (!units.length) {
      $('ttkResult').innerHTML = '<div class="msg warn">Нет корректных юнитов — импортируйте данные во вкладке «Импорт».</div>';
      $('ttkMatrix').innerHTML = '';
      return;
    }
    const has = id => units.some(u => String(u.id) === String(id));
    $('ttkAttacker').value = has(state.ttk.attacker) ? state.ttk.attacker : units[0].id;
    $('ttkTarget').value = has(state.ttk.target) ? state.ttk.target : (units[1] || units[0]).id;
    renderTTKResult();
    renderMatrix(units);
  }

  function renderTTKResult() {
    const units = validUnits();
    const a = units.find(u => String(u.id) === $('ttkAttacker').value);
    const t = units.find(u => String(u.id) === $('ttkTarget').value);
    if (!a || !t) return;
    const o = ttkOpts();
    const r = F.computeTTK(a, t, o);
    const sim = F.simulateHits(a, t, o, 2000);
    const card = (k, v, cls = '') => `<div class="card ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('ttkResult').innerHTML =
      card('Урон за удар (без крита)', fmt(r.normal)) +
      card('Урон крита', r.critChance > 0 ? fmt(r.crit) : '—') +
      card('Ожидаемый урон за удар', fmt(r.expected)) +
      card('DPS', fmt(r.dps)) +
      card('Ударов до убийства (ожид.)', r.hitsExpected) +
      card('Ударов: без критов / все криты', `${r.hitsWorst} / ${r.hitsBest}`) +
      card('TTK ожидаемый, с', fmt(r.ttkExpected), 'ok') +
      card('TTK диапазон, с', `${fmt(r.ttkBest)} … ${fmt(r.ttkWorst)}`) +
      card('Симуляция (2000 боёв), ударов', fmt(sim)) +
      `<div class="card" style="grid-column:1/-1"><div class="k">Расчёт по шагам</div><div>` +
      `max(${a.attack} − ${t.defense}, ${a.attack} × ${o.minDamageRatio}) × ${o.multiplier} = <b>${fmt(r.normal)}</b>; ` +
      (r.critChance > 0 ? `ожидаемый = ${fmt(r.normal)} × (1 + ${r.critChance} × (${r.critMult} − 1)) = <b>${fmt(r.expected)}</b>; ` : '') +
      `удары = ⌈${t.hp} / ${fmt(r.expected)}⌉ = <b>${r.hitsExpected}</b>; TTK = (${r.hitsExpected} − 1) / ${r.speed} = <b>${fmt(r.ttkExpected)} с</b></div></div>`;
  }

  function renderMatrix(units) {
    const o = ttkOpts();
    const data = units.map(a => units.map(t => F.computeTTK(a, t, o).ttkExpected));
    const finite = data.flat().filter(isFinite);
    const max = Math.max(1e-9, ...finite);
    const heat = cssVar('--heat');
    $('ttkMatrix').innerHTML = '<thead><tr><th>атк ↓ / цель →</th>' + units.map(u => `<th>${esc(u.name)}</th>`).join('') + '</tr></thead><tbody>' +
      units.map((a, i) => `<tr><th>${esc(a.name)}</th>` + data[i].map(v => {
        const alpha = isFinite(v) ? (0.08 + 0.6 * v / max).toFixed(2) : 0.7;
        return `<td class="num" style="background: rgba(${heat}, ${alpha})">${fmt(v, 1)}</td>`;
      }).join('') + '</tr>').join('') + '</tbody>';
  }

  // ---------- 4. Прогрессия ----------
  const PRESETS = {
    linear: { a: 0, b: 1, c: 100 },
    poly: { a: 100, b: 1.5, c: 0 },
    steep: { a: 50, b: 2.2, c: 20 },
  };
  const progIds = { a: 'pA', b: 'pB', c: 'pC', maxLevel: 'pMax', statBase: 'pStatBase', statGrowth: 'pStatGrowth' };
  Object.entries(progIds).forEach(([k, id]) => $(id).addEventListener('input', () => {
    state.progression[k] = numVal(id);
    if (k === 'maxLevel') state.progression.maxLevel = Math.min(200, Math.max(2, Math.round(state.progression.maxLevel)));
    save(); renderProgression(false);
  }));
  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    Object.assign(state.progression, PRESETS[b.dataset.preset]); save(); renderProgression();
  }));
  $('exportProgCsv').addEventListener('click', () => D.download(`progression_${stamp()}.csv`, D.toCSV(F.progressionTable(state.progression)), 'text/csv;charset=utf-8'));
  $('exportProgJson').addEventListener('click', () => D.download(`progression_${stamp()}.json`,
    JSON.stringify({ params: state.progression, levels: F.progressionTable(state.progression) }, null, 2), 'application/json'));

  const charts = {};
  function makeChart(key, canvasId, config) {
    if (charts[key]) charts[key].destroy();
    const canvas = $(canvasId);
    if (typeof Chart === 'undefined') {
      canvas.parentElement.innerHTML = '<p class="muted">Chart.js не загрузился (нет интернета?) — график недоступен, таблица ниже работает.</p>';
      return;
    }
    const text = cssVar('--text'), grid = cssVar('--border');
    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;
    charts[key] = new Chart(canvas, config);
  }

  function renderProgression(syncInputs = true) {
    const p = state.progression;
    if (syncInputs) Object.entries(progIds).forEach(([k, id]) => ($(id).value = p[k]));
    const rows = F.progressionTable(p);
    $('progTable').innerHTML = '<thead><tr><th class="num">Уровень</th><th class="num">Опыт до след.</th><th class="num">Всего опыта</th><th class="num">Стат</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td class="num">${r.level}</td><td class="num">${r.xpToNext ? fmt(r.xpToNext, 0) : '—'}</td><td class="num">${fmt(r.totalXp, 0)}</td><td class="num">${fmt(r.stat, 0)}</td></tr>`).join('') + '</tbody>';
    const accent = cssVar('--accent'), warn = cssVar('--warn'), ok = cssVar('--ok');
    makeChart('prog', 'progChart', {
      type: 'line',
      data: {
        labels: rows.map(r => r.level),
        datasets: [
          { label: 'Опыт до след. уровня', data: rows.map(r => r.xpToNext || null), borderColor: accent, backgroundColor: accent, yAxisID: 'y', tension: 0.2 },
          { label: 'Всего опыта', data: rows.map(r => r.totalXp), borderColor: warn, backgroundColor: warn, yAxisID: 'y', borderDash: [5, 4], tension: 0.2 },
          { label: 'Стат', data: rows.map(r => r.stat), borderColor: ok, backgroundColor: ok, yAxisID: 'y1', tension: 0.2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { title: { display: true, text: 'Уровень' } },
          y: { title: { display: true, text: 'Опыт' }, beginAtZero: true },
          y1: { position: 'right', title: { display: true, text: 'Стат' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // ---------- 5. Лут ----------
  $('lootTol').addEventListener('input', () => { state.lootTol = Math.max(0, numVal('lootTol')); save(); renderLoot(); });
  $('normalizeLoot').addEventListener('click', () => {
    const tables = F.checkLoot(state.loot, state.lootTol);
    let changed = 0;
    tables.forEach(t => {
      if (t.ok || t.sum <= 0) return;
      const rows = t.rows.map(x => x.row).filter(r => isFinite(Number(r.chance)) && Number(r.chance) >= 0);
      rows.forEach(r => (r.chance = Math.round(Number(r.chance) / t.sum * 100 * 1e4) / 1e4));
      // погрешность округления убираем на самом вероятном предмете, чтобы сумма была ровно 100
      const rest = Math.round((100 - rows.reduce((s, r) => s + r.chance, 0)) * 1e4) / 1e4;
      const top = rows.reduce((m, r) => (r.chance > m.chance ? r : m), rows[0]);
      if (top) top.chance = Math.round((top.chance + rest) * 1e4) / 1e4;
      changed++;
    });
    save(); renderLoot();
    toast(changed ? `Нормализовано таблиц: ${changed}` : 'Нечего нормализовать');
  });
  $('exportLootReport').addEventListener('click', () => {
    const tables = F.checkLoot(state.loot, state.lootTol);
    if (!tables.length) return toast('Нет данных лута');
    const rows = [];
    tables.forEach(t => t.rows.forEach(({ row, index }) => rows.push({
      table_id: t.id, id: row.id, item: row.item, chance: row.chance, rarity: row.rarity || '',
      table_sum: t.sum, table_status: t.ok ? 'OK' : 'ERROR',
      row_errors: t.errors.filter(e => e.index === index).map(e => e.msg).join('; '),
    })));
    D.download(`loot_report_${stamp()}.csv`, D.toCSV(rows), 'text/csv;charset=utf-8');
  });
  $('exportLootJson').addEventListener('click', () => exportSet('loot', 'json'));
  $('runSim').addEventListener('click', runSim);

  function renderLoot() {
    $('lootTol').value = state.lootTol; $('lootTolLabel').textContent = state.lootTol;
    const tables = F.checkLoot(state.loot, state.lootTol);
    if (!tables.length) {
      $('lootSummary').innerHTML = '<div class="msg warn">Нет данных лута — импортируйте CSV во вкладке «Импорт» (набор «Лут»).</div>';
      $('lootTables').innerHTML = ''; $('simTable').innerHTML = ''; $('simResult').innerHTML = '';
      return;
    }
    const bad = tables.filter(t => !t.ok).length;
    $('lootSummary').innerHTML =
      `<div class="card"><div class="k">Таблиц дропа</div><div class="v">${tables.length}</div></div>` +
      `<div class="card ${bad ? 'bad' : 'ok'}"><div class="k">С ошибками</div><div class="v">${bad}</div></div>` +
      `<div class="card"><div class="k">Предметов</div><div class="v">${state.loot.length}</div></div>`;
    $('lootTables').innerHTML = tables.map(t => {
      const status = t.ok ? '<span class="badge ok">OK</span>'
        : `<span class="badge bad">Ошибка: сумма ${fmt(t.sum, 4)}% (${t.diff > 0 ? '+' : ''}${fmt(t.diff, 4)})</span>`;
      return `<div class="loot-table"><h3>Таблица «${esc(t.id)}» ${status}</h3><div class="table-wrap"><table class="grid">` +
        '<thead><tr><th>id</th><th>Предмет</th><th>Редкость</th><th class="num">Шанс, %</th><th>Доля</th><th>Проблема</th></tr></thead><tbody>' +
        t.rows.map(({ row, index }) => {
          const errs = t.errors.filter(e => e.index === index);
          const cls = errs.some(e => !e.warn) ? 'bad' : errs.length ? 'warn' : '';
          const c = Number(row.chance);
          const w = isFinite(c) && t.sum > 0 ? Math.max(0, Math.min(100, c / Math.max(t.sum, 100) * 100)) : 0;
          return `<tr class="${cls}"><td>${esc(row.id)}</td><td>${esc(row.item)}</td><td>${esc(row.rarity || '')}</td><td class="num">${esc(row.chance)}</td>` +
            `<td><div style="width:120px;height:8px;background:var(--surface-2);border-radius:4px"><div style="width:${w}%;height:100%;background:var(--accent);border-radius:4px"></div></div></td>` +
            `<td>${errs.map(e => esc(e.msg)).join('; ')}</td></tr>`;
        }).join('') +
        `</tbody><tfoot><tr><th colspan="3">Сумма</th><th class="num">${fmt(t.sum, 4)}</th><th colspan="2"></th></tr></tfoot></table></div></div>`;
    }).join('');
    const prev = $('simTable').value;
    $('simTable').innerHTML = tables.map(t => `<option value="${esc(t.id)}">${esc(t.id)}</option>`).join('');
    if (tables.some(t => t.id === prev)) $('simTable').value = prev;
  }

  function runSim() {
    const tables = F.checkLoot(state.loot, state.lootTol);
    const t = tables.find(x => x.id === $('simTable').value);
    if (!t) return;
    const n = Math.min(1e6, Math.max(1, Math.round(numVal('simN'))));
    const rows = t.rows.map(x => x.row);
    const counts = F.simulateDrops(rows, n);
    const sum = rows.reduce((s, r) => s + Math.max(0, Number(r.chance) || 0), 0);
    $('simResult').innerHTML = '<thead><tr><th>Предмет</th><th class="num">Заявлено, %</th><th class="num">Выпало</th><th class="num">Факт, %</th><th class="num">Отклонение, п.п.</th></tr></thead><tbody>' +
      rows.map(r => {
        const fact = counts[r.id] / n * 100;
        const expected = sum > 0 ? Math.max(0, Number(r.chance) || 0) / sum * 100 : 0;
        return `<tr><td>${esc(r.item)}</td><td class="num">${esc(r.chance)}</td><td class="num">${counts[r.id]}</td><td class="num">${fmt(fact, 2)}</td><td class="num">${fmt(fact - expected, 2)}</td></tr>`;
      }).join('') + '</tbody>' +
      (Math.abs(sum - 100) > state.lootTol ? `<tfoot><tr><td colspan="5" class="muted">Сумма шансов ${fmt(sum, 4)}% ≠ 100% — при симуляции шансы нормированы на сумму.</td></tr></tfoot>` : '');
  }

  // ---------- Аудит ----------
  $('auditK').addEventListener('input', () => { state.auditK = numVal('auditK'); save(); renderAudit(); });
  function renderAudit() {
    $('auditK').value = state.auditK;
    const units = validUnits();
    const res = F.auditUnits(units, ttkOpts(), state.auditK);
    if (!res.rows) {
      $('auditTable').innerHTML = '<tbody><tr><td class="muted">Нужно минимум 2 корректных юнита.</td></tr></tbody>';
      return;
    }
    const sorted = res.rows.slice().sort((a, b) => b.value - a.value);
    const label = { dominant: '<span class="badge warn">доминирующий</span>', useless: '<span class="badge bad">бесполезный</span>', ok: '<span class="badge ok">норма</span>' };
    $('auditTable').innerHTML = '<thead><tr><th>Юнит</th><th class="num">Цена</th><th class="num">HP</th><th class="num">Ср. DPS</th><th class="num">Сила</th><th class="num">Сила / цена</th><th class="num">z</th><th>Вердикт</th></tr></thead><tbody>' +
      sorted.map(r => `<tr class="${r.verdict}"><td>${esc(r.unit.name)}</td><td class="num">${fmt(r.unit.cost, 0)}</td><td class="num">${fmt(r.unit.hp, 0)}</td><td class="num">${fmt(r.avgDps)}</td><td class="num">${fmt(r.power, 0)}</td><td class="num">${fmt(r.value)}</td><td class="num">${fmt(r.z)}</td><td>${label[r.verdict]}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td colspan="8" class="muted">Среднее «сила / цена» = ${fmt(res.mean)}, σ = ${fmt(res.sd)}</td></tr></tfoot>`;
    const colors = { dominant: cssVar('--warn'), useless: cssVar('--err'), ok: cssVar('--accent') };
    makeChart('audit', 'auditChart', {
      type: 'bar',
      data: { labels: sorted.map(r => r.unit.name), datasets: [{ label: 'Сила / цена', data: sorted.map(r => r.value), backgroundColor: sorted.map(r => colors[r.verdict]) }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } },
    });
  }

  // ---------- Инфляция ----------
  const inflIds = { start: 'iStart', income: 'iIncome', incomeGrowth: 'iGrowth', sinkFixed: 'iSinkFixed', sinkPercent: 'iSinkPct', steps: 'iSteps' };
  Object.entries(inflIds).forEach(([k, id]) => $(id).addEventListener('input', () => {
    state.inflation[k] = numVal(id);
    state.inflation.steps = Math.min(1000, Math.max(1, Math.round(state.inflation.steps)));
    save(); renderInflation(false);
  }));
  function renderInflation(syncInputs = true) {
    const p = state.inflation;
    if (syncInputs) Object.entries(inflIds).forEach(([k, id]) => ($(id).value = p[k]));
    const rows = F.simulateInflation(p);
    const last = rows[rows.length - 1];
    const trend = last.income > last.sink ? 'растёт (инфляция)' : last.income < last.sink ? 'падает (дефляция)' : 'стабилен';
    $('inflSummary').innerHTML =
      `<div class="card"><div class="k">Запас через ${p.steps} шагов</div><div class="v">${fmt(last.stock, 0)}</div></div>` +
      `<div class="card"><div class="k">Доход / сток на последнем шаге</div><div class="v">${fmt(last.income, 0)} / ${fmt(last.sink, 0)}</div></div>` +
      `<div class="card ${last.income > last.sink * 1.1 ? 'bad' : 'ok'}"><div class="k">Тренд</div><div class="v" style="font-size:16px">${trend}</div></div>`;
    makeChart('infl', 'inflChart', {
      type: 'line',
      data: {
        labels: rows.map(r => r.step),
        datasets: [
          { label: 'Запас', data: rows.map(r => r.stock), borderColor: cssVar('--accent'), yAxisID: 'y' },
          { label: 'Доход', data: rows.map(r => r.income), borderColor: cssVar('--ok'), yAxisID: 'y1' },
          { label: 'Сток', data: rows.map(r => r.sink), borderColor: cssVar('--err'), yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        scales: { y: { title: { display: true, text: 'Запас' } }, y1: { position: 'right', title: { display: true, text: 'За шаг' }, grid: { drawOnChartArea: false } } },
      },
    });
  }

  // ---------- Экспорт всего и горячие клавиши ----------
  function exportAll() {
    D.download(`balance_project_${stamp()}.json`, JSON.stringify({
      exportedAt: new Date().toISOString(),
      units: clean(state.units), loot: clean(state.loot),
      ttkSettings: state.ttk, progression: { params: state.progression, levels: F.progressionTable(state.progression) },
      lootCheck: F.checkLoot(state.loot, state.lootTol).map(t => ({ table_id: t.id, sum: t.sum, ok: t.ok, errors: t.errors.map(e => ({ id: t.rows.find(x => x.index === e.index).row.id, msg: e.msg })) })),
      inflation: state.inflation,
    }, null, 2), 'application/json');
  }
  $('exportAllJson').addEventListener('click', exportAll);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportAll(); return; }
    if (!e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= TABS.length) { e.preventDefault(); showTab(TABS[n - 1]); }
    else if (e.code === 'KeyT') { e.preventDefault(); toggleTheme(); }
    else if (e.code === 'KeyN') { e.preventDefault(); showTab('table'); addRow(); }
  });

  // ---------- Старт ----------
  applyTheme();
  showTab(TABS.includes(state.tab) ? state.tab : 'import');
})();
