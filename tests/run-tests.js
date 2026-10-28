// Запуск: node tests/run-tests.js
// Каждое ожидаемое значение посчитано вручную (см. ОТЧЁТ.md, раздел «Ручная проверка формул»).
const F = require('../js/formulas.js');
const D = require('../js/data.js');

let passed = 0, failed = 0;
function eq(name, actual, expected, eps = 1e-9) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= eps : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}

const swordsman = { hp: 120, attack: 25, defense: 10 };
const archer = { hp: 80, attack: 35, defense: 5 };
const knight = { hp: 180, attack: 20, defense: 20 };
const mage = { hp: 70, attack: 45, defense: 3 };

// --- TTK ---
// Мечник → Лучник: 25 − 5 = 20; ⌈80/20⌉ = 4 удара; TTK = (4−1)/1 = 3 с
let r = F.computeTTK(swordsman, archer);
eq('Мечник→Лучник урон', r.normal, 20);
eq('Мечник→Лучник удары', r.hitsExpected, 4);
eq('Мечник→Лучник TTK', r.ttkExpected, 3);

// Маг → Рыцарь: 45 − 20 = 25; ⌈180/25⌉ = ⌈7.2⌉ = 8; TTK = 7 с
r = F.computeTTK(mage, knight);
eq('Маг→Рыцарь урон', r.normal, 25);
eq('Маг→Рыцарь удары', r.hitsExpected, 8);
eq('Маг→Рыцарь TTK', r.ttkExpected, 7);

// Мечник → Рыцарь: 25 − 20 = 5, но минимум 25 × 0.1 = 2.5 → 5; ⌈180/5⌉ = 36
r = F.computeTTK(swordsman, knight);
eq('Мечник→Рыцарь удары', r.hitsExpected, 36);

// Минимальный урон: атака 10 против защиты 50 → max(−40, 1) = 1
eq('Минимальный урон', F.damagePerHit(10, 50, { minDamageRatio: 0.1 }), 1);

// Криты: Мечник → Лучник, шанс 10%, ×2: 20 × (1 + 0.1 × 1) = 22; ⌈80/22⌉ = ⌈3.64⌉ = 4; все криты: ⌈80/40⌉ = 2
r = F.computeTTK(swordsman, archer, { critChance: 0.1, critMult: 2 });
eq('Крит ожидаемый урон', r.expected, 22);
eq('Крит удары ожид.', r.hitsExpected, 4);
eq('Крит удары лучший', r.hitsBest, 2);

// Скорость атаки 2 уд/с: Маг → Рыцарь 8 ударов → TTK = 7/2 = 3.5 с
r = F.computeTTK(Object.assign({ attack_speed: 2 }, mage), knight);
eq('TTK при скорости 2', r.ttkExpected, 3.5);
eq('DPS при скорости 2', r.dps, 50);

// Точное деление: 100 HP / 20 урона = ровно 5 ударов (не 6)
eq('Точное деление', F.hitsToKill(100, 20), 5);

// --- Прогрессия: A=100, B=1.5, C=0 ---
// L1: 100·1^1.5 = 100; L2: 100·2^1.5 = 282.84 → 283; L3: 100·3^1.5 = 519.62 → 520
const p = { a: 100, b: 1.5, c: 0, maxLevel: 5, statBase: 100, statGrowth: 0.1 };
const t = F.progressionTable(p);
eq('XP L1→2', t[0].xpToNext, 100);
eq('XP L2→3', t[1].xpToNext, 283);
eq('XP L3→4', t[2].xpToNext, 520);
eq('Всего XP для L4', t[3].totalXp, 903);
// Стат: 100·1.1^2 = 121, 100·1.1^4 = 146.41 → 146
eq('Стат L3', t[2].stat, 121);
eq('Стат L5', t[4].stat, 146);
// Линейная: A=0, C=100 → 100·L
eq('Линейная L7', F.xpToNext(7, { a: 0, b: 1, c: 100 }), 700);

// --- Лут ---
const loot = [
  { id: 1, table_id: 'a', chance: 55 }, { id: 2, table_id: 'a', chance: 25 }, { id: 3, table_id: 'a', chance: 15 },
  { id: 4, table_id: 'a', chance: 4.5 }, { id: 5, table_id: 'a', chance: 0.5 },
  { id: 6, table_id: 'b', chance: 50 }, { id: 7, table_id: 'b', chance: 30 }, { id: 8, table_id: 'b', chance: 15 },
  { id: 9, table_id: 'c', chance: 0.1 }, { id: 10, table_id: 'c', chance: 0.2 }, { id: 11, table_id: 'c', chance: 99.7 },
  { id: 12, table_id: 'd', chance: 110 }, { id: 13, table_id: 'd', chance: -10 },
];
const chk = F.checkLoot(loot);
eq('Лут a сумма 100 → OK', [chk[0].sum, chk[0].ok], [100, true]);
eq('Лут b сумма 95 → ошибка', [chk[1].sum, chk[1].ok], [95, false]);
eq('Лут c 0.1+0.2+99.7 = 100 (без ошибки float)', [chk[2].sum, chk[2].ok], [100, true]);
eq('Лут d: сумма 100, но шансы >100 и <0 → ошибка', [chk[3].sum, chk[3].ok, chk[3].errors.length], [100, false, 2]);

// Симуляция с фиксированным генератором: 100 000 дропов, отклонение < 1 п.п.
let seed = 42;
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const counts = F.simulateDrops(loot.slice(0, 5), 100000, rng);
eq('Симуляция: монета ≈ 55%', Math.abs(counts[1] / 1000 - 55) < 1, true);

// --- CSV ---
const csv = 'id;name;hp;attack;defense;cost\n1;"Мечник; ""элита""";120;25;10;100\n';
const parsed = D.parseCSV(csv);
eq('CSV с ; и кавычками', parsed.records[0].name, 'Мечник; "элита"');
const v = D.validate(D.parseCSV('id,name,hp,attack,defense,cost\n1,A,сто,1,1,1\n1,B,10,1,1,1\n'), 'units');
eq('Валидация: не число + дубль', v.errors.map(e => e.col), ['hp', 'id']);
eq('Валидация: нет колонки cost', D.validate(D.parseCSV('id,name,hp,attack,defense\n1,A,1,1,1'), 'units').errors.length, 1);
// round-trip без потерь
const rows = [{ id: 1, name: 'Маг, "огненный"', hp: 70.5 }];
const back = D.parseCSV(D.toCSV(rows)).records[0];
eq('CSV round-trip', [back.id, back.name, back.hp], ['1', 'Маг, "огненный"', '70.5']);

console.log(`\nИтого: ${passed} OK, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
