import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseDateComponents,
    getDayOfWeekName,
    formatFullDateEs,
    getWeekRange,
    groupAbsenceDaysByWeek,
    calculateEmployeeAbsenceHistory,
    findEmployeeInText,
    parseDomainQuery,
    answerDomainQuery,
    type AbsenceRecordLike,
    type EmployeeInfoLike,
    type DomainQAContext
} from '../../dist/sistema-asistencia/shared/absence-analytics.js';

test('parseDateComponents y formatters de fecha en español', () => {
    const comp = parseDateComponents('2026-02-11');
    assert.deepEqual(comp, { year: 2026, month: 2, day: 11 });

    assert.equal(parseDateComponents('invalid-date'), null);
    assert.equal(parseDateComponents(''), null);

    // 2026-02-11 fue Miércoles
    const dayName = getDayOfWeekName('2026-02-11');
    assert.equal(dayName, 'Miércoles');

    const formatted = formatFullDateEs('2026-02-11', true);
    assert.match(formatted, /Miércoles 11 de Febrero de 2026/);

    const formattedNoYear = formatFullDateEs('2026-02-11', false);
    assert.match(formattedNoYear, /Miércoles 11 de Febrero/);
});

test('getWeekRange: calcula rango correcto de lunes a domingo', () => {
    // 2026-02-11 es miércoles. La semana va del lunes 09/02 al domingo 15/02
    const range = getWeekRange('2026-02-11');
    assert.equal(range.startDate, '2026-02-09');
    assert.equal(range.endDate, '2026-02-15');
    assert.equal(range.label, '09/02 al 15/02');
});

test('calculateEmployeeAbsenceHistory: suma de cada mes y qué días faltó en la semana de ese mes', () => {
    const employee: EmployeeInfoLike = {
        id: 1,
        employee_code: 'EMP-001',
        first_name: 'Juan',
        last_name: 'Pérez',
        department_name: 'Sistemas',
        position: 'Desarrollador'
    };

    const records: AbsenceRecordLike[] = [
        // Febrero 2026: 3 faltas
        // Semana del 09/02 al 15/02 (Miércoles y Viernes)
        { employee_id: 1, date: '2026-02-11', status: 'absent', notes: 'Gripe' },
        { employee_id: 1, date: '2026-02-13', status: 'absent' },
        // Semana del 16/02 al 22/02 (Lunes)
        { employee_id: 1, date: '2026-02-16', status: 'absent' },

        // Enero 2026: 2 faltas
        // Semana del 05/01 al 11/01 (Jueves)
        { employee_id: 1, date: '2026-01-08', status: 'absent' },
        // Semana del 19/01 al 25/01 (Martes)
        { employee_id: 1, date: '2026-01-20', status: 'absent' },

        // Registro de presente (no debe contarse en ausencias)
        { employee_id: 1, date: '2026-02-10', status: 'present' },
        { employee_id: 1, date: '2026-02-12', status: 'late', minutes_late: 15 }
    ];

    const history = calculateEmployeeAbsenceHistory(records, employee);

    // Métricas globales
    assert.equal(history.totalAbsences, 5);
    assert.equal(history.monthsWithAbsencesCount, 2);
    assert.equal(history.averagePerMonth, 2.5);
    assert.equal(history.worstMonth?.monthName, 'Febrero 2026');
    assert.equal(history.worstMonth?.total, 3);

    // Desglose por mes (orden descendente: Febrero 2026 primero, Enero 2026 segundo)
    assert.equal(history.months.length, 2);
    const feb = history.months[0];
    assert.equal(feb.monthKey, '2026-02');
    assert.equal(feb.monthName, 'Febrero 2026');
    assert.equal(feb.totalAbsences, 3); // Suma de faltas en febrero

    // Desglose semanal de Febrero
    assert.equal(feb.weeks.length, 2);
    const febWeek1 = feb.weeks[0]; // Semana del 09/02 al 15/02
    assert.equal(febWeek1.totalDays, 2);
    assert.equal(febWeek1.days[0].date, '2026-02-11');
    assert.equal(febWeek1.days[0].dayOfWeek, 'Miércoles');
    assert.equal(febWeek1.days[0].notes, 'Gripe');
    assert.equal(febWeek1.days[1].date, '2026-02-13');
    assert.equal(febWeek1.days[1].dayOfWeek, 'Viernes');

    const febWeek2 = feb.weeks[1]; // Semana del 16/02 al 22/02
    assert.equal(febWeek2.totalDays, 1);
    assert.equal(febWeek2.days[0].date, '2026-02-16');
    assert.equal(febWeek2.days[0].dayOfWeek, 'Lunes');

    // Desglose de Enero
    const ene = history.months[1];
    assert.equal(ene.monthKey, '2026-01');
    assert.equal(ene.totalAbsences, 2);
    assert.equal(ene.weeks.length, 2);
    assert.equal(ene.weeks[0].days[0].dayOfWeek, 'Jueves');
    assert.equal(ene.weeks[1].days[0].dayOfWeek, 'Martes');

    // Distribución por día de la semana
    assert.equal(history.dayOfWeekDistribution['Miércoles'], 1);
    assert.equal(history.dayOfWeekDistribution['Viernes'], 1);
    assert.equal(history.dayOfWeekDistribution['Lunes'], 1);
    assert.equal(history.dayOfWeekDistribution['Jueves'], 1);
    assert.equal(history.dayOfWeekDistribution['Martes'], 1);
    assert.equal(history.dayOfWeekDistribution['Sábado'], 0);
});

test('calculateEmployeeAbsenceHistory: empleado con 0 faltas se maneja limpiamente', () => {
    const employee: EmployeeInfoLike = {
        id: 2,
        employee_code: 'EMP-002',
        first_name: 'María',
        last_name: 'López'
    };

    const records: AbsenceRecordLike[] = [
        { employee_id: 2, date: '2026-02-10', status: 'present' },
        { employee_id: 2, date: '2026-02-11', status: 'present' }
    ];

    const history = calculateEmployeeAbsenceHistory(records, employee);
    assert.equal(history.totalAbsences, 0);
    assert.equal(history.monthsWithAbsencesCount, 0);
    assert.equal(history.averagePerMonth, 0);
    assert.equal(history.worstMonth, undefined);
    assert.equal(history.months.length, 0);
});

test('findEmployeeInText: reconoce códigos con guión, sin guión, y nombres', () => {
    const employees: EmployeeInfoLike[] = [
        { id: 1, employee_code: 'EMP-001', first_name: 'Juan', last_name: 'Pérez' },
        { id: 2, employee_code: 'EMP-002', first_name: 'María', last_name: 'González' },
        { id: 3, employee_code: 'EMP-015', first_name: 'Roberto', last_name: 'Hernández' }
    ];

    // Por código exacto
    assert.equal(findEmployeeInText('Historial de faltas de EMP-001', employees)?.id, 1);
    // Por código sin guión minúsculas
    assert.equal(findEmployeeInText('faltas del emp002', employees)?.id, 2);
    // Por nombre completo
    assert.equal(findEmployeeInText('que dias falto juan perez en la semana', employees)?.id, 1);
    // Por apellido
    assert.equal(findEmployeeInText('asistencia de gonzalez', employees)?.id, 2);
    // Si no coincide
    assert.equal(findEmployeeInText('consulta general', employees), undefined);
});

test('parseDomainQuery y answerDomainQuery: interpreta palabras clave de dominio (empleado, falta, tiempo, retardo)', () => {
    const employees: EmployeeInfoLike[] = [
        { id: 1, employee_code: 'EMP-001', first_name: 'Juan', last_name: 'Pérez', department_name: 'Sistemas' },
        { id: 2, employee_code: 'EMP-002', first_name: 'María', last_name: 'González', department_name: 'Ventas' }
    ];

    const records: AbsenceRecordLike[] = [
        { employee_id: 1, date: '2026-02-11', status: 'absent' },
        { employee_id: 1, date: '2026-02-13', status: 'absent' },
        { employee_id: 1, date: '2026-02-10', status: 'present', check_in_time: '08:00', check_out_time: '17:00' },
        { employee_id: 1, date: '2026-02-12', status: 'late', minutes_late: 20 },
        { employee_id: 2, date: '2026-02-11', status: 'present' },
        { employee_id: 2, date: '2026-02-12', status: 'absent' }
    ];

    const ctx: DomainQAContext = {
        employees,
        attendanceRecords: records
    };

    // 1. Consulta de historial de faltas de empleado
    const q1 = parseDomainQuery('¿Qué días faltó el empleado EMP-001 en la semana?', ctx);
    assert.equal(q1.intent, 'EMPLOYEE_ABSENCE_HISTORY');
    assert.equal(q1.targetEmployee?.id, 1);
    assert.ok(q1.matchedKeywords.includes('empleado'));
    assert.ok(q1.matchedKeywords.includes('falto'));
    assert.ok(q1.matchedKeywords.includes('semana'));

    const res1 = answerDomainQuery('¿Qué días faltó el empleado EMP-001 en la semana?', ctx);
    assert.equal(res1.detailsType, 'absence_tree');
    assert.match(res1.naturalAnswer, /Juan Pérez/);
    assert.match(res1.naturalAnswer, /2 faltas/);
    assert.equal(res1.kpis.find(k => k.label === 'Total de Faltas')?.value, 2);

    // 2. Consulta de tiempo trabajado
    const q2 = parseDomainQuery('¿Cuánto tiempo trabajó el empleado EMP-001?', ctx);
    assert.equal(q2.intent, 'EMPLOYEE_TIME_WORKED');
    assert.equal(q2.targetEmployee?.id, 1);
    assert.ok(q2.matchedKeywords.includes('tiempo'));

    const res2 = answerDomainQuery('¿Cuánto tiempo trabajó el empleado EMP-001?', ctx);
    assert.equal(res2.detailsType, 'records_table');
    assert.match(res2.naturalAnswer, /horas trabajadas/);

    // 3. Consulta de retardos
    const q3 = parseDomainQuery('retardos y minutos tarde de EMP-001', ctx);
    assert.equal(q3.intent, 'EMPLOYEE_LATE_SUMMARY');
    const res3 = answerDomainQuery('retardos y minutos tarde de EMP-001', ctx);
    assert.equal(res3.kpis.find(k => k.label === 'Total Retardos')?.value, 1);
    assert.equal(res3.kpis.find(k => k.label === 'Minutos Tarde Acumulados')?.value, '20 min');

    // 4. Consulta de ranking: quién tiene más faltas
    const q4 = parseDomainQuery('¿Quién tiene más faltas en el personal?', ctx);
    assert.equal(q4.intent, 'TOP_ABSENCES');
    const res4 = answerDomainQuery('¿Quién tiene más faltas en el personal?', ctx);
    assert.equal(res4.detailsType, 'ranking_list');
    assert.equal(res4.kpis.find(k => k.label === 'Líder en Faltas')?.value, 'Juan Pérez');

    // 5. Consulta general multivariable
    const q5 = parseDomainQuery('resumen general de personal faltas y tiempo', ctx);
    assert.equal(q5.intent, 'GENERAL_METRICS');
    const res5 = answerDomainQuery('resumen general de personal faltas y tiempo', ctx);
    assert.ok(res5.kpis.length >= 3);
});
