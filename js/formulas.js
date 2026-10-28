/*
 * Чистые функции расчётов (без DOM). Подключаются и в браузере, и в Node (tests/run-tests.js).
 */
(function (root) {
  'use strict';

  // ---------- Урон / TTK ----------
  // Формула урона за один удар:
  //   base   = max(attack - defense, attack * minDamageRatio)   — защита не может обнулить урон полностью
  //   normal = base * multiplier                                — множитель (бафф, тип урона и т.п.)
  //   crit   = normal * critMult
  //   ожидаемый = normal * (1 + critChance * (critMult - 1))
  // Удары до убийства = ceil(hp / урон). TTK = (удары - 1) / скорость атаки
  // (первый удар наносится в момент t = 0, поэтому одного удара достаточно для TTK = 0).
  function damagePerHit(attack, defense, opts) {
    const o = Object.assign({ multiplier: 1, minDamageRatio: 0.1 }, opts || {});
    const base = Math.max(attack - defense, attack * o.minDamageRatio);
    return Math.max(0, base * o.multiplier);
  }

  function expectedDamage(normal, critChance, critMult) {
    return normal * (1 + critChance * (critMult - 1));
  }

  function hitsToKill(hp, dmg) {
    if (dmg <= 0) return Infinity;
    // небольшой допуск, чтобы 80 / 20.000000001 не превращалось в 5
    return Math.max(1, Math.ceil(hp / dmg - 1e-9));
  }

  function ttkSeconds(hits, attackSpeed) {
    if (!isFinite(hits) || attackSpeed <= 0) return Infinity;
    return (hits - 1) / attackSpeed;
  }

  function computeTTK(attacker, target, opts) {
    const o = Object.assign({ multiplier: 1, minDamageRatio: 0.1, critChance: 0, critMult: 2 }, opts || {});
    const speed = num(attacker.attack_speed, 1);
    const critChance = clamp(num(attacker.crit_chance, o.critChance), 0, 1);
    const critMult = num(attacker.crit_mult, o.critMult);

    const normal = damagePerHit(attacker.attack, target.defense, o);
    const crit = normal * critMult;
    const expected = expectedDamage(normal, critChance, critMult);

    const hitsExpected = hitsToKill(target.hp, expected);
    const hitsWorst = hitsToKill(target.hp, normal);              // ни одного крита
    const hitsBest = hitsToKill(target.hp, critChance > 0 ? crit : normal); // все удары — криты

    return {
      normal, crit, expected, speed, critChance, critMult,
      dps: expected * speed,
      hitsExpected, hitsWorst, hitsBest,
      ttkExpected: ttkSeconds(hitsExpected, speed),
      ttkWorst: ttkSeconds(hitsWorst, speed),
      ttkBest: ttkSeconds(hitsBest, speed),
    };
  }

  // Монте-Карло: средние удары до убийства со случайными критами (для сверки с ожидаемым значением)
  function simulateHits(attacker, target, opts, runs, rng) {
    const r = computeTTK(attacker, target, opts);
    rng = rng || Math.random;
    let total = 0;
    for (let i = 0; i < runs; i++) {
      let hp = target.hp, hits = 0;
      while (hp > 1e-9 && hits < 1e6) {
        hp -= rng() < r.critChance ? r.crit : r.normal;
        hits++;
      }
      total += hits;
    }
    return total / runs;
  }

  // ---------- Прогрессия ----------
  // Опыт для перехода с уровня L на L+1:  xpNext(L) = round(A * L^B + C * L)
  // Накопленный опыт для достижения уровня L: сумма xpNext(1..L-1)
  // Стат на уровне L: stat(L) = round(base * (1 + g)^(L-1))
  function xpToNext(level, p) {
    return Math.round(p.a * Math.pow(level, p.b) + p.c * level);
  }

  function progressionTable(p) {
    const rows = [];
    let total = 0;
    for (let L = 1; L <= p.maxLevel; L++) {
      const next = L < p.maxLevel ? xpToNext(L, p) : 0;
      rows.push({
        level: L,
        xpToNext: next,
        totalXp: total, // сколько нужно набрать с нуля, чтобы оказаться на этом уровне
        stat: Math.round(p.statBase * Math.pow(1 + p.statGrowth, L - 1)),
      });
      total += next;
    }
    return rows;
  }

  // ---------- Лут ----------
  // Группирует строки по table_id, проверяет сумму вероятностей = 100 (с допуском) и корректность каждой строки.
  function checkLoot(rows, tolerance) {
    tolerance = tolerance == null ? 0.01 : tolerance;
    const tables = {};
    rows.forEach((r, i) => {
      const key = String(r.table_id == null || r.table_id === '' ? 'default' : r.table_id);
      (tables[key] = tables[key] || { id: key, rows: [], sum: 0, errors: [] }).rows.push({ row: r, index: i });
    });
    Object.values(tables).forEach(t => {
      t.rows.forEach(({ row, index }) => {
        const c = Number(row.chance);
        if (!isFinite(c)) t.errors.push({ index, msg: 'шанс не число' });
        else if (c < 0) t.errors.push({ index, msg: 'отрицательный шанс' });
        else if (c > 100) t.errors.push({ index, msg: 'шанс больше 100%' });
        else if (c === 0) t.errors.push({ index, msg: 'шанс 0% — предмет никогда не выпадет', warn: true });
        if (isFinite(c)) t.sum += c;
      });
      t.sum = Math.round(t.sum * 1e6) / 1e6;
      t.diff = Math.round((t.sum - 100) * 1e6) / 1e6;
      t.ok = Math.abs(t.diff) <= tolerance && t.errors.every(e => e.warn);
    });
    return Object.values(tables);
  }

  // Симуляция N дропов из одной таблицы (шансы нормируются на сумму, чтобы работало и на ошибочной таблице)
  function simulateDrops(tableRows, n, rng) {
    rng = rng || Math.random;
    const items = tableRows.map(r => ({ id: r.id, w: Math.max(0, Number(r.chance) || 0) }));
    const sum = items.reduce((s, x) => s + x.w, 0);
    const counts = {};
    items.forEach(x => (counts[x.id] = 0));
    if (sum <= 0) return counts;
    for (let i = 0; i < n; i++) {
      let roll = rng() * sum;
      for (const x of items) {
        roll -= x.w;
        if (roll < 0) { counts[x.id]++; break; }
      }
    }
    return counts;
  }

  // ---------- Аудит баланса ----------
  // Сила юнита = (средний DPS против всех остальных) * hp. Эффективность = сила / цена.
  // Доминирующий: эффективность > среднее + k*σ; бесполезный: < среднее − k*σ.
  function auditUnits(units, opts, k) {
    k = k == null ? 1 : k;
    if (units.length < 2) return [];
    const res = units.map(u => {
      const others = units.filter(x => x !== u);
      const avgDps = others.reduce((s, t) => s + computeTTK(u, t, opts).dps, 0) / others.length;
      const power = avgDps * u.hp;
      return { unit: u, avgDps, power, value: u.cost > 0 ? power / u.cost : Infinity };
    });
    const vals = res.map(r => r.value).filter(isFinite);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    res.forEach(r => {
      r.z = sd > 0 ? (r.value - mean) / sd : 0;
      r.verdict = !isFinite(r.value) || r.z > k ? 'dominant' : r.z < -k ? 'useless' : 'ok';
    });
    return { rows: res, mean, sd };
  }

  // ---------- Инфляция ----------
  // Каждый шаг: запас += Σ источников * (1 + рост)^шаг − Σ стоков; стоки — фиксированные или % от запаса.
  function simulateInflation(p) {
    const out = [];
    let stock = p.start;
    for (let step = 1; step <= p.steps; step++) {
      const income = p.income * Math.pow(1 + p.incomeGrowth, step - 1);
      const sink = p.sinkFixed + stock * p.sinkPercent;
      stock = Math.max(0, stock + income - sink);
      out.push({ step, income, sink, stock });
    }
    return out;
  }

  function num(v, def) {
    const n = Number(v);
    return v === '' || v == null || !isFinite(n) ? def : n;
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  const api = {
    damagePerHit, expectedDamage, hitsToKill, ttkSeconds, computeTTK, simulateHits,
    xpToNext, progressionTable, checkLoot, simulateDrops, auditUnits, simulateInflation,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Formulas = api;
})(this);
