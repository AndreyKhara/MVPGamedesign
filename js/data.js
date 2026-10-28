/*
 * CSV/JSON: разбор, сериализация, валидация по схеме набора данных.
 */
(function (root) {
  'use strict';

  // Схемы наборов данных: обязательные колонки, числовые колонки, необязательные колонки
  const SCHEMAS = {
    units: {
      title: 'Юниты',
      required: ['id', 'name', 'hp', 'attack', 'defense', 'cost'],
      numeric: ['hp', 'attack', 'defense', 'cost', 'attack_speed', 'crit_chance', 'crit_mult'],
      optional: ['attack_speed', 'crit_chance', 'crit_mult'],
      ranges: { hp: [1, Infinity], attack: [0, Infinity], defense: [0, Infinity], cost: [0, Infinity],
        attack_speed: [0.01, Infinity], crit_chance: [0, 1], crit_mult: [1, Infinity] },
    },
    loot: {
      title: 'Лут',
      required: ['id', 'table_id', 'item', 'chance'],
      numeric: ['chance'],
      optional: ['rarity'],
      ranges: { chance: [-Infinity, Infinity] }, // диапазон шанса проверяет модуль «Лут» с подсветкой
    },
  };

  // RFC 4180-совместимый разбор: кавычки, экранирование "", переносы строк внутри кавычек.
  // Разделитель определяется автоматически (',' или ';' — Excel в русской локали сохраняет с ';').
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delim = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ',';
    const rows = [];
    let row = [], field = '', inQuotes = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (inQuotes) throw new Error('Незакрытая кавычка в CSV');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
    if (!nonEmpty.length) throw new Error('Файл пустой');
    const header = nonEmpty[0].map(h => h.trim().toLowerCase());
    const records = nonEmpty.slice(1).map((r, idx) => {
      const o = {};
      header.forEach((h, j) => (o[h] = (r[j] == null ? '' : r[j]).trim()));
      o.__line = idx + 2; // номер строки в файле (с учётом заголовка) — для сообщений об ошибках
      o.__extra = r.length > header.length;
      return o;
    });
    return { header, records, delimiter: delim };
  }

  function countOutsideQuotes(line, ch) {
    let n = 0, q = false;
    for (const c of line) { if (c === '"') q = !q; else if (c === ch && !q) n++; }
    return n;
  }

  function parseJSON(text) {
    let data = JSON.parse(text.replace(/^﻿/, ''));
    if (!Array.isArray(data)) {
      // допускаем { "units": [...] } или { "data": [...] }
      const arr = Object.values(data || {}).find(Array.isArray);
      if (!arr) throw new Error('JSON должен быть массивом объектов или содержать массив');
      data = arr;
    }
    const header = [];
    const records = data.map((o, idx) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`Элемент ${idx + 1} не объект`);
      const r = {};
      Object.keys(o).forEach(k => {
        const key = k.trim().toLowerCase();
        if (!header.includes(key)) header.push(key);
        r[key] = o[k] == null ? '' : String(o[k]).trim();
      });
      r.__line = idx + 1;
      return r;
    });
    return { header, records };
  }

  // Возвращает { rows, errors, warnings }. rows — уже с числовыми типами.
  function validate(parsed, schemaName) {
    const s = SCHEMAS[schemaName];
    const errors = [], warnings = [];
    const missing = s.required.filter(c => !parsed.header.includes(c));
    if (missing.length) {
      errors.push({ line: 1, msg: `Нет обязательных колонок: ${missing.join(', ')}` });
      return { rows: [], errors, warnings };
    }
    if (!parsed.records.length) errors.push({ line: 1, msg: 'Нет ни одной строки данных' });
    const seen = new Map();
    const rows = parsed.records.map(rec => {
      const out = {};
      parsed.header.forEach(h => (out[h] = rec[h]));
      if (rec.__extra) warnings.push({ line: rec.__line, msg: 'В строке больше значений, чем колонок — лишние отброшены' });
      s.required.forEach(c => {
        if (rec[c] === '' || rec[c] == null) errors.push({ line: rec.__line, col: c, msg: `пустое значение «${c}»` });
      });
      s.numeric.forEach(c => {
        if (!(c in rec) || rec[c] === '') return;
        const v = Number(String(rec[c]).replace(',', '.'));
        if (!isFinite(v)) { errors.push({ line: rec.__line, col: c, msg: `«${c}» = "${rec[c]}" — не число` }); return; }
        const [lo, hi] = s.ranges[c] || [-Infinity, Infinity];
        if (v < lo || v > hi) errors.push({ line: rec.__line, col: c, msg: `«${c}» = ${v} вне диапазона [${lo}; ${hi}]` });
        out[c] = v;
      });
      const id = String(rec.id);
      if (id !== '') {
        if (seen.has(id)) errors.push({ line: rec.__line, col: 'id', msg: `дубль ID «${id}» (впервые в строке ${seen.get(id)})` });
        else seen.set(id, rec.__line);
      }
      return out;
    });
    return { rows, errors, warnings };
  }

  function toCSV(rows, columns) {
    columns = columns || collectColumns(rows);
    const esc = v => {
      const s = v == null ? '' : String(v);
      return /[",;\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(esc).join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  function collectColumns(rows) {
    const cols = [];
    rows.forEach(r => Object.keys(r).forEach(k => { if (!k.startsWith('__') && !cols.includes(k)) cols.push(k); }));
    return cols;
  }

  function download(filename, content, mime) {
    // BOM нужен, чтобы Excel корректно открыл кириллицу в CSV
    const bom = mime.startsWith('text/csv') ? '﻿' : '';
    const blob = new Blob([bom + content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const api = { SCHEMAS, parseCSV, parseJSON, validate, toCSV, collectColumns, download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Data = api;
})(this);
