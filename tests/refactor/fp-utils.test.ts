import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    groupToMap,
    groupBy,
    countToMap,
    countBy,
    indexToMap,
    indexBy,
    partition,
    pipe,
    summarizeAttendance,
    type AttendanceRecordLike
} from '../../dist/sistema-asistencia/shared/fp-utils.js';

test('groupToMap y groupBy: agrupan elementos sin mutar la entrada y protegen contra prototype pollution', () => {
    const items = [
        { id: 1, dept: 'IT', name: 'Ana' },
        { id: 2, dept: 'HR', name: 'Luis' },
        { id: 3, dept: 'IT', name: 'Carlos' }
    ];

    const map = groupToMap(items, x => x.dept);
    assert.equal(map.get('IT')?.length, 2);
    assert.equal(map.get('HR')?.length, 1);
    assert.equal(map.get('Ventas'), undefined);

    const record = groupBy(items, x => x.dept);
    assert.equal(record.IT.length, 2);
    assert.equal(record.HR.length, 1);

    // Protección anti-prototype pollution
    const malicious = [
        { id: 1, key: '__proto__' },
        { id: 2, key: 'constructor' },
        { id: 3, key: 'safe' }
    ];
    const groupedSafe = groupBy(malicious, x => x.key);
    assert.equal(Object.prototype.hasOwnProperty.call(groupedSafe, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(groupedSafe, 'constructor'), false);
    assert.equal(groupedSafe.safe?.length, 1);
});

test('countToMap y countBy: cuentan frecuencias con complejidad O(N)', () => {
    const list = [
        { status: 'present' },
        { status: 'present' },
        { status: 'late' },
        { status: 'absent' },
        { status: 'present' }
    ];

    const mapCounts = countToMap(list, x => x.status);
    assert.equal(mapCounts.get('present'), 3);
    assert.equal(mapCounts.get('late'), 1);
    assert.equal(mapCounts.get('absent'), 1);
    assert.equal(mapCounts.get('unknown'), undefined);

    const objCounts = countBy(list, x => x.status);
    assert.equal(objCounts.present, 3);
    assert.equal(objCounts.late, 1);
    assert.equal(objCounts.absent, 1);
});

test('indexToMap e indexBy: indexan elementos en O(N) para acceso O(1)', () => {
    const employees = [
        { id: 10, name: 'Alice' },
        { id: 20, name: 'Bob' },
        { id: 30, name: 'Charlie' }
    ];

    const map = indexToMap(employees, e => e.id);
    assert.equal(map.get(20)?.name, 'Bob');
    assert.equal(map.get(99), undefined);

    const record = indexBy(employees, e => e.id);
    assert.equal(record[30]?.name, 'Charlie');
});

test('partition: separa una lista en [truthy, falsy] en una sola pasada pura', () => {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
    const [evens, odds] = partition(numbers, n => n % 2 === 0);

    assert.deepEqual(evens, [2, 4, 6, 8]);
    assert.deepEqual(odds, [1, 3, 5, 7]);
});

test('pipe: composición funcional pura de izquierda a derecha', () => {
    const add5 = (n: number) => n + 5;
    const double = (n: number) => n * 2;
    const toStr = (n: number) => `Val: ${n}`;

    const result = pipe(10, add5, double, toStr);
    assert.equal(result, 'Val: 30');
});

test('summarizeAttendance: calcula métricas completas en una sola pasada O(N)', () => {
    const records: AttendanceRecordLike[] = [
        { status: 'present', fingerprint_verified: true, minutes_late: 0, minutes_overtime: 15 },
        { status: 'present', fingerprint_verified: 1, minutes_late: 0, minutes_overtime: 30 },
        { status: 'late', fingerprint_verified: true, minutes_late: 20, minutes_overtime: 0 },
        { status: 'late', fingerprint_verified: false, minutes_late: 10, minutes_overtime: 0 },
        { status: 'absent', fingerprint_verified: false, minutes_late: 0, minutes_overtime: 0 }
    ];

    const summary = summarizeAttendance(records);

    assert.equal(summary.total, 5);
    assert.equal(summary.present, 2);
    assert.equal(summary.late, 2);
    assert.equal(summary.absent, 1);
    assert.equal(summary.verified, 3);
    assert.equal(summary.totalLateMinutes, 30);
    assert.equal(summary.avgLateMinutes, 6); // 30 / 5
    assert.equal(summary.totalOvertimeMinutes, 45);
    assert.equal(summary.avgOvertimeMinutes, 9); // 45 / 5
    assert.equal(summary.attendanceRate, '80.0'); // (2 present + 2 late) / 5 = 80.0%
    assert.equal(summary.punctualityRate, '40.0'); // 2 / 5 = 40.0%
});

test('summarizeAttendance: maneja lista vacía sin divisiones por cero', () => {
    const summary = summarizeAttendance([]);

    assert.equal(summary.total, 0);
    assert.equal(summary.present, 0);
    assert.equal(summary.late, 0);
    assert.equal(summary.absent, 0);
    assert.equal(summary.verified, 0);
    assert.equal(summary.totalLateMinutes, 0);
    assert.equal(summary.avgLateMinutes, 0);
    assert.equal(summary.totalOvertimeMinutes, 0);
    assert.equal(summary.avgOvertimeMinutes, 0);
    assert.equal(summary.attendanceRate, '0.0');
    assert.equal(summary.punctualityRate, '0.0');
});

test('summarizeAttendance: tolera nulos o undefined en minutos y estados', () => {
    const records: AttendanceRecordLike[] = [
        { status: null, fingerprint_verified: null, minutes_late: null, minutes_overtime: undefined },
        { status: undefined, fingerprint_verified: undefined, minutes_late: undefined, minutes_overtime: null }
    ];

    const summary = summarizeAttendance(records);

    assert.equal(summary.total, 2);
    assert.equal(summary.present, 0);
    assert.equal(summary.late, 0);
    assert.equal(summary.absent, 0);
    assert.equal(summary.verified, 0);
    assert.equal(summary.totalLateMinutes, 0);
    assert.equal(summary.totalOvertimeMinutes, 0);
    assert.equal(summary.attendanceRate, '0.0');
});
