/**
 * Módulo Analítico de Faltas, Asistencia y Explorador de Preguntas de Dominio (NLP & Data Science)
 * 
 * Principios:
 * - Programación Funcional (FP): funciones puras, inmutabilidad, pipelines sin efectos secundarios.
 * - Data Science: Agregación de series temporales (año -> mes -> semana -> día), analítica descriptiva,
 *   frecuencias, cálculo de tasas, promedios y correlación tiempo-asistencia.
 * - Procesamiento de Lenguaje Natural de Dominio (Domain NLP): Mapeo declarativo de palabras clave
 *   ('empleado', 'falta', 'tiempo', 'retardo', etc.) para responder consultas contextuales en español.
 */

import { groupToMap, countToMap, summarizeAttendance, type AttendanceRecordLike } from './fp-utils.js';
import { timeToMinutes } from './date-utils.js';

export interface AbsenceDayItem {
    readonly id?: number;              // ID del registro attendance_records
    readonly employeeId?: number;      // ID del empleado
    readonly date: string;             // YYYY-MM-DD
    readonly dayOfWeek: string;        // 'Lunes', 'Martes', etc.
    readonly dayOfMonth: number;       // 1..31
    readonly formattedDate: string;    // 'Lunes 16 de Febrero'
    readonly notes?: string;
}

export interface AbsenceWeekGroup {
    readonly weekNumber: number;       // 1..5 relativa dentro del mes
    readonly weekLabel: string;        // 'Semana 1 (01/02 al 07/02)'
    readonly startDate: string;        // YYYY-MM-DD del lunes de la semana
    readonly endDate: string;          // YYYY-MM-DD del domingo de la semana
    readonly totalDays: number;
    readonly days: readonly AbsenceDayItem[];
}

export interface AbsenceMonthGroup {
    readonly monthKey: string;         // 'YYYY-MM'
    readonly year: number;
    readonly monthNumber: number;      // 1..12
    readonly monthName: string;        // 'Febrero 2026'
    readonly totalAbsences: number;    // Suma de faltas en este mes
    readonly weeks: readonly AbsenceWeekGroup[];
}

export interface EmployeeInfoLike {
    readonly id: number;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly email?: string;
    readonly phone?: string;
    readonly department_name?: string;
    readonly position?: string;
    readonly photo_url?: string | null;
}

export interface AbsenceRecordLike extends AttendanceRecordLike {
    readonly id?: number;
    readonly employee_id: number;
    readonly date: string;             // YYYY-MM-DD
    readonly check_in_time?: string | null;
    readonly check_out_time?: string | null;
    readonly status: string;
    readonly notes?: string | null;
    readonly employee_code?: string;
    readonly employee_name?: string;
    readonly department_name?: string;
}

export interface EmployeeAbsenceHistoryResult {
    readonly employee: EmployeeInfoLike;
    readonly totalAbsences: number;
    readonly monthsWithAbsencesCount: number;
    readonly averagePerMonth: number;
    readonly worstMonth?: { readonly monthName: string; readonly total: number };
    readonly months: readonly AbsenceMonthGroup[];
    readonly dayOfWeekDistribution: Record<string, number>;
}

export const DAYS_OF_WEEK_ES = [
    'Domingo',
    'Lunes',
    'Martes',
    'Miércoles',
    'Jueves',
    'Viernes',
    'Sábado'
] as const;

export const MONTH_NAMES_ES = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre'
] as const;

/**
 * Parsea fecha YYYY-MM-DD de forma segura y devuelve componentes enteros.
 */
export function parseDateComponents(dateStr: string): { year: number; month: number; day: number } | null {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.trim().split('-');
    if (parts.length < 3) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    return { year, month, day };
}

/**
 * Obtiene el nombre del día de la semana en español para una fecha YYYY-MM-DD.
 */
export function getDayOfWeekName(dateStr: string): string {
    const comp = parseDateComponents(dateStr);
    if (!comp) return 'Desconocido';
    const d = new Date(comp.year, comp.month - 1, comp.day);
    return DAYS_OF_WEEK_ES[d.getDay()] || 'Desconocido';
}

/**
 * Formatea una fecha YYYY-MM-DD a formato legible: "Miércoles 11 de Febrero de 2026".
 */
export function formatFullDateEs(dateStr: string, includeYear: boolean = true): string {
    const comp = parseDateComponents(dateStr);
    if (!comp) return dateStr || '';
    const dayName = getDayOfWeekName(dateStr);
    const monthName = MONTH_NAMES_ES[comp.month - 1] || `Mes ${comp.month}`;
    const dayPadded = String(comp.day).padStart(2, '0');
    return includeYear 
        ? `${dayName} ${dayPadded} de ${monthName} de ${comp.year}`
        : `${dayName} ${dayPadded} de ${monthName}`;
}

/**
 * Calcula el rango de lunes a domingo para una fecha específica.
 */
export function getWeekRange(dateStr: string): { startDate: string; endDate: string; label: string } {
    const comp = parseDateComponents(dateStr);
    if (!comp) {
        return { startDate: dateStr, endDate: dateStr, label: dateStr };
    }
    const d = new Date(comp.year, comp.month - 1, comp.day);
    const dayIdx = d.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    // Ajuste para que la semana empiece en Lunes
    const diffToMonday = dayIdx === 0 ? -6 : 1 - dayIdx;
    
    const monday = new Date(comp.year, comp.month - 1, comp.day + diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

    const pad = (n: number) => String(n).padStart(2, '0');
    const startStr = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
    const endStr = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
    const label = `${pad(monday.getDate())}/${pad(monday.getMonth() + 1)} al ${pad(sunday.getDate())}/${pad(sunday.getMonth() + 1)}`;

    return { startDate: startStr, endDate: endStr, label };
}

/**
 * Agrupa una lista de fechas dentro de un mes por sus semanas correspondientes.
 * Función pura O(N log N).
 */
export function groupAbsenceDaysByWeek(days: readonly AbsenceDayItem[]): readonly AbsenceWeekGroup[] {
    if (!days || days.length === 0) return [];

    // Agrupar por semana usando el inicio de la semana (Lunes)
    const weekMap = new Map<string, { range: { startDate: string; endDate: string; label: string }; items: AbsenceDayItem[] }>();

    for (let i = 0; i < days.length; i++) {
        const item = days[i];
        const range = getWeekRange(item.date);
        const existing = weekMap.get(range.startDate);
        if (existing) {
            existing.items.push(item);
        } else {
            weekMap.set(range.startDate, { range, items: [item] });
        }
    }

    // Ordenar semanas cronológicamente
    const sortedWeeks = Array.from(weekMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    return sortedWeeks.map(([_, data], index) => {
        // Ordenar días dentro de la semana
        const sortedItems = [...data.items].sort((a, b) => a.date.localeCompare(b.date));
        return {
            weekNumber: index + 1,
            weekLabel: `Semana ${index + 1} (${data.range.label})`,
            startDate: data.range.startDate,
            endDate: data.range.endDate,
            totalDays: sortedItems.length,
            days: sortedItems
        };
    });
}

/**
 * Calcula el historial de faltas de un empleado:
 * - Suma de cada mes que tuvo falta del mes correspondiente
 * - Qué días faltó en la semana de ese mes
 * - Frecuencia y distribución de días
 */
export function calculateEmployeeAbsenceHistory(
    records: readonly AbsenceRecordLike[],
    employee: EmployeeInfoLike
): EmployeeAbsenceHistoryResult {
    // 1. Filtrar registros con status = 'absent'
    const absences = (records || []).filter(r => r.status === 'absent');

    // 2. Mapear días con detalles
    const dayDistribution: Record<string, number> = {
        'Lunes': 0, 'Martes': 0, 'Miércoles': 0, 'Jueves': 0, 'Viernes': 0, 'Sábado': 0, 'Domingo': 0
    };

    const monthBuckets = new Map<string, AbsenceDayItem[]>();

    for (let i = 0; i < absences.length; i++) {
        const r = absences[i];
        const comp = parseDateComponents(r.date);
        if (!comp) continue;

        const dayName = getDayOfWeekName(r.date);
        if (dayDistribution[dayName] !== undefined) {
            dayDistribution[dayName] = (dayDistribution[dayName] || 0) + 1;
        }

        const monthKey = `${comp.year}-${String(comp.month).padStart(2, '0')}`;
        const dayItem: AbsenceDayItem = {
            id: r.id,
            employeeId: r.employee_id,
            date: r.date,
            dayOfWeek: dayName,
            dayOfMonth: comp.day,
            formattedDate: formatFullDateEs(r.date, false),
            notes: r.notes || undefined
        };

        const existing = monthBuckets.get(monthKey);
        if (existing) {
            existing.push(dayItem);
        } else {
            monthBuckets.set(monthKey, [dayItem]);
        }
    }

    // 3. Ordenar meses cronológicamente descendente (el más reciente primero)
    const sortedMonthKeys = Array.from(monthBuckets.keys()).sort((a, b) => b.localeCompare(a));

    let worstMonth: { monthName: string; total: number } | undefined = undefined;

    const months: AbsenceMonthGroup[] = sortedMonthKeys.map(mKey => {
        const [yearStr, monthStr] = mKey.split('-');
        const year = parseInt(yearStr, 10);
        const monthNum = parseInt(monthStr, 10);
        const monthName = `${MONTH_NAMES_ES[monthNum - 1] || 'Mes ' + monthNum} ${year}`;
        const items = monthBuckets.get(mKey) || [];
        const total = items.length;

        if (!worstMonth || total > worstMonth.total) {
            worstMonth = { monthName, total };
        }

        const weeks = groupAbsenceDaysByWeek(items);

        return {
            monthKey: mKey,
            year,
            monthNumber: monthNum,
            monthName,
            totalAbsences: total,
            weeks
        };
    });

    const totalAbsences = absences.length;
    const monthsWithAbsencesCount = months.length;
    const averagePerMonth = monthsWithAbsencesCount > 0 
        ? Math.round((totalAbsences / monthsWithAbsencesCount) * 10) / 10 
        : 0;

    return {
        employee,
        totalAbsences,
        monthsWithAbsencesCount,
        averagePerMonth,
        worstMonth,
        months,
        dayOfWeekDistribution: dayDistribution
    };
}

// ============================================================================
// DOMAIN Q&A ENGINE (NLP DE ASISTENCIA Y RRHH)
// ============================================================================

export type DomainQueryIntent = 
    | 'EMPLOYEE_ABSENCE_HISTORY'
    | 'EMPLOYEE_TIME_WORKED'
    | 'EMPLOYEE_LATE_SUMMARY'
    | 'TOP_ABSENCES'
    | 'TOP_LATE'
    | 'TODAY_STATUS'
    | 'DEPARTMENT_STATS'
    | 'GENERAL_METRICS'
    | 'UNKNOWN';

export interface DomainParsedQuery {
    readonly rawQuery: string;
    readonly intent: DomainQueryIntent;
    readonly targetEmployee?: EmployeeInfoLike;
    readonly targetDepartment?: string;
    readonly temporalScope?: 'today' | 'week' | 'month' | 'year' | 'all';
    readonly matchedKeywords: readonly string[];
    readonly confidence: number;
}

export interface DomainQueryResult {
    readonly parsed: DomainParsedQuery;
    readonly title: string;
    readonly naturalAnswer: string;
    readonly kpis: readonly { readonly label: string; readonly value: string | number; readonly color?: string }[];
    readonly detailsType: 'absence_tree' | 'records_table' | 'ranking_list' | 'department_grid' | 'none';
    readonly data?: any;
}

export interface DomainQAContext {
    readonly employees: readonly EmployeeInfoLike[];
    readonly attendanceRecords: readonly AbsenceRecordLike[];
    readonly departments?: readonly { id: number; name: string }[];
}

/**
 * Normaliza una cadena quitando tildes, signos de puntuación y espacios extras.
 */
export function normalizeDomainText(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
        .replace(/[¿?¡!.,:;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extrae o localiza un empleado a partir de una nómina, matrícula o nombre en la consulta.
 */
export function findEmployeeInText(
    text: string, 
    employees: readonly EmployeeInfoLike[]
): EmployeeInfoLike | undefined {
    if (!text || !employees || employees.length === 0) return undefined;
    const norm = normalizeDomainText(text);

    // 1. Coincidencia por código de empleado exacto o normalizado (ej. EMP-001, EMP001, 001)
    for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const codeNorm = normalizeDomainText(emp.employee_code);
        const codeNoHyphen = codeNorm.replace(/[-_]/g, '');

        // Regex de límite de palabra para el código
        const codeRegex = new RegExp(`\\b${codeNorm.replace('-', '[-_]?')}\\b`, 'i');
        const codeNoHyphenRegex = new RegExp(`\\b${codeNoHyphen}\\b`, 'i');

        if (codeRegex.test(norm) || codeNoHyphenRegex.test(norm.replace(/[-_]/g, ''))) {
            return emp;
        }
    }

    // 2. Coincidencia por extracción de patrón tipo EMP-123 o matrícula
    const matchEmp = norm.match(/\bemp\s*[-_]?\s*(\d+)\b/i);
    if (matchEmp) {
        const numericPart = matchEmp[1];
        const found = employees.find(e => {
            const numE = e.employee_code.replace(/\D/g, '');
            return numE === numericPart || parseInt(numE, 10) === parseInt(numericPart, 10);
        });
        if (found) return found;
    }

    // 3. Coincidencia por nombre completo o primer nombre + apellido
    for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const fullName = normalizeDomainText(`${emp.first_name} ${emp.last_name}`);
        if (fullName.length > 3 && norm.includes(fullName)) {
            return emp;
        }
    }

    // 4. Coincidencia por apellido o primer nombre si tiene suficiente longitud (> 3 letras)
    for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const first = normalizeDomainText(emp.first_name);
        const last = normalizeDomainText(emp.last_name);
        if (first.length >= 4 && new RegExp(`\\b${first}\\b`).test(norm)) return emp;
        if (last.length >= 4 && new RegExp(`\\b${last}\\b`).test(norm)) return emp;
    }

    return undefined;
}

/**
 * Analizador semántico y clasificador de intenciones (Domain Intent Router)
 */
export function parseDomainQuery(
    rawQuery: string,
    context: DomainQAContext
): DomainParsedQuery {
    const norm = normalizeDomainText(rawQuery);
    const matchedKeywords: string[] = [];

    const checkWords = (words: readonly string[]): boolean => {
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (new RegExp(`\\b${w}\\b`).test(norm)) {
                if (!matchedKeywords.includes(w)) matchedKeywords.push(w);
                return true;
            }
        }
        return false;
    };

    const hasAbsence = checkWords(['falta', 'faltas', 'falto', 'faltó', 'ausente', 'ausentes', 'ausencia', 'ausencias', 'inasistencia', 'inasistencias']);
    const hasLate = checkWords(['retardo', 'retardos', 'tarde', 'tardanza', 'tardanzas', 'demora', 'retraso', 'impuntual']);
    const hasTime = checkWords(['tiempo', 'hora', 'horas', 'jornada', 'trabajadas', 'trabajado', 'sobretiempo', 'duracion']);
    const hasEmployeeWord = checkWords(['empleado', 'empleados', 'personal', 'colaborador', 'colaboradores', 'trabajador', 'trabajadores', 'nomina', 'matricula']);
    const hasWeek = checkWords(['semana', 'semanas', 'semanal']);
    const hasMonth = checkWords(['mes', 'meses', 'mensual']);
    const hasToday = checkWords(['hoy', 'actual']);
    const hasRanking = checkWords(['mas', 'menos', 'top', 'mayor', 'menor', 'quien', 'cuales', 'ranking']);

    const targetEmployee = findEmployeeInText(rawQuery, context.employees);

    let temporalScope: 'today' | 'week' | 'month' | 'year' | 'all' = 'all';
    if (hasToday) temporalScope = 'today';
    else if (hasWeek) temporalScope = 'week';
    else if (hasMonth) temporalScope = 'month';

    let intent: DomainQueryIntent = 'UNKNOWN';
    let confidence = 0.5;

    // Reglas de decisión basadas en jerarquía semántica
    if (targetEmployee && hasLate) {
        intent = 'EMPLOYEE_LATE_SUMMARY';
        confidence = 0.95;
    } else if (targetEmployee && hasTime) {
        intent = 'EMPLOYEE_TIME_WORKED';
        confidence = 0.9;
    } else if (targetEmployee && (hasAbsence || hasWeek || hasMonth || /historial|dias/i.test(norm) || (!hasTime && !hasLate))) {
        intent = 'EMPLOYEE_ABSENCE_HISTORY';
        confidence = 0.95;
    } else if (hasRanking && hasAbsence) {
        intent = 'TOP_ABSENCES';
        confidence = 0.9;
    } else if (hasRanking && hasLate) {
        intent = 'TOP_LATE';
        confidence = 0.9;
    } else if (hasToday || (/quien.*(vino|falto|llego)/i.test(norm))) {
        intent = 'TODAY_STATUS';
        confidence = 0.85;
    } else if (checkWords(['departamento', 'departamentos', 'area', 'areas'])) {
        intent = 'DEPARTMENT_STATS';
        confidence = 0.8;
    } else if (hasAbsence || hasTime || hasLate || hasEmployeeWord) {
        intent = 'GENERAL_METRICS';
        confidence = 0.7;
    }

    return {
        rawQuery,
        intent,
        targetEmployee,
        temporalScope,
        matchedKeywords,
        confidence
    };
}

/**
 * Responde una consulta en lenguaje natural con métricas de Data Science y visualización enriquecida.
 */
export function answerDomainQuery(
    rawQuery: string,
    context: DomainQAContext
): DomainQueryResult {
    const parsed = parseDomainQuery(rawQuery, context);
    const { employees, attendanceRecords } = context;

    switch (parsed.intent) {
        case 'EMPLOYEE_ABSENCE_HISTORY': {
            const emp = parsed.targetEmployee;
            if (!emp) {
                return {
                    parsed,
                    title: 'Búsqueda de Historial de Faltas',
                    naturalAnswer: 'Por favor especifica la nómina, matrícula o nombre del empleado para consultar su historial detallado de inasistencias.',
                    kpis: [],
                    detailsType: 'none'
                };
            }

            const empRecords = attendanceRecords.filter(r => r.employee_id === emp.id);
            const history = calculateEmployeeAbsenceHistory(empRecords, emp);

            const worstStr = history.worstMonth 
                ? `El mes con mayor índice de inasistencias fue ${history.worstMonth.monthName} con ${history.worstMonth.total} faltas.` 
                : 'No registra meses con faltas consecutivas.';

            const natural = history.totalAbsences === 0
                ? `El colaborador ${emp.first_name} ${emp.last_name} (${emp.employee_code}) tiene un registro impecable: 0 faltas registradas en el sistema.`
                : `El empleado ${emp.first_name} ${emp.last_name} (Nómina: ${emp.employee_code}) registra un total acumulado de ${history.totalAbsences} faltas, distribuidas a lo largo de ${history.monthsWithAbsencesCount} mes(es) con un promedio de ${history.averagePerMonth} faltas por mes con registro. ${worstStr}`;

            return {
                parsed,
                title: `Historial de Faltas: ${emp.first_name} ${emp.last_name} (${emp.employee_code})`,
                naturalAnswer: natural,
                kpis: [
                    { label: 'Total de Faltas', value: history.totalAbsences, color: '#EF4444' },
                    { label: 'Meses con Faltas', value: history.monthsWithAbsencesCount, color: '#F59E0B' },
                    { label: 'Promedio Mensual', value: history.averagePerMonth, color: '#3B82F6' },
                    { label: 'Día Más Frecuente', value: getMostFrequentDay(history.dayOfWeekDistribution), color: '#8B5CF6' }
                ],
                detailsType: 'absence_tree',
                data: history
            };
        }

        case 'EMPLOYEE_TIME_WORKED': {
            const emp = parsed.targetEmployee;
            if (!emp) {
                return {
                    parsed,
                    title: 'Tiempo Trabajado',
                    naturalAnswer: 'Indica la matrícula o nombre del colaborador para calcular sus horas y tiempos laborados.',
                    kpis: [],
                    detailsType: 'none'
                };
            }

            const empRecords = attendanceRecords.filter(r => r.employee_id === emp.id && (r.status === 'present' || r.status === 'late'));
            let totalMinutes = 0;
            let overtimeMinutes = 0;

            for (let i = 0; i < empRecords.length; i++) {
                const r = empRecords[i];
                if (r.minutes_overtime) overtimeMinutes += r.minutes_overtime;
                // Si tiene check_in y check_out, calcular tiempo exacto
                if (r.check_in_time && r.check_out_time) {
                    const diff = diffInMinutes(r.check_in_time, r.check_out_time);
                    if (diff > 0) totalMinutes += diff;
                } else {
                    // Turno estándar aproximado de 8 horas (480 min)
                    totalMinutes += 480;
                }
            }

            const totalHours = (totalMinutes / 60).toFixed(1);
            const overtimeHours = (overtimeMinutes / 60).toFixed(1);

            return {
                parsed,
                title: `Registro de Tiempo: ${emp.first_name} ${emp.last_name} (${emp.employee_code})`,
                naturalAnswer: `El colaborador ha acumulado aproximadamente ${totalHours} horas trabajadas en ${empRecords.length} días de asistencia, incluyendo ${overtimeHours} horas de tiempo extra registrado.`,
                kpis: [
                    { label: 'Horas Trabajadas', value: `${totalHours} hrs`, color: '#10B981' },
                    { label: 'Días Asistidos', value: empRecords.length, color: '#3B82F6' },
                    { label: 'Horas Extra', value: `${overtimeHours} hrs`, color: '#F59E0B' }
                ],
                detailsType: 'records_table',
                data: empRecords
            };
        }

        case 'EMPLOYEE_LATE_SUMMARY': {
            const emp = parsed.targetEmployee;
            if (!emp) {
                return {
                    parsed,
                    title: 'Resumen de Retardos',
                    naturalAnswer: 'Indica la matrícula o nombre del colaborador para consultar sus retardos e impuntualidades.',
                    kpis: [],
                    detailsType: 'none'
                };
            }

            const lates = attendanceRecords.filter(r => r.employee_id === emp.id && r.status === 'late');
            const totalLateMins = lates.reduce((acc, r) => acc + (r.minutes_late || 0), 0);
            const avgLate = lates.length > 0 ? Math.round(totalLateMins / lates.length) : 0;

            return {
                parsed,
                title: `Retardos: ${emp.first_name} ${emp.last_name} (${emp.employee_code})`,
                naturalAnswer: lates.length === 0
                    ? `El empleado ${emp.first_name} ${emp.last_name} no registra retardos en el historial. Mantiene puntualidad al 100%.`
                    : `El empleado acumula ${lates.length} llegadas tarde con un total de ${totalLateMins} minutos de demora acumulados (promedio de ${avgLate} min por retardo).`,
                kpis: [
                    { label: 'Total Retardos', value: lates.length, color: '#F59E0B' },
                    { label: 'Minutos Tarde Acumulados', value: `${totalLateMins} min`, color: '#EF4444' },
                    { label: 'Promedio por Retardo', value: `${avgLate} min`, color: '#6B7280' }
                ],
                detailsType: 'records_table',
                data: lates
            };
        }

        case 'TOP_ABSENCES': {
            // Contar faltas por empleado
            const counts = new Map<number, number>();
            for (let i = 0; i < attendanceRecords.length; i++) {
                const r = attendanceRecords[i];
                if (r.status === 'absent') {
                    counts.set(r.employee_id, (counts.get(r.employee_id) || 0) + 1);
                }
            }

            const ranking = Array.from(counts.entries())
                .map(([empId, count]) => {
                    const emp = employees.find(e => e.id === empId);
                    return {
                        id: empId,
                        code: emp?.employee_code || `EMP-${empId}`,
                        name: emp ? `${emp.first_name} ${emp.last_name}` : `Empleado ${empId}`,
                        dept: emp?.department_name || 'Sin departamento',
                        count
                    };
                })
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            const natural = ranking.length > 0
                ? `El ranking de mayor inasistencia está encabezado por ${ranking[0].name} (${ranking[0].code}) con ${ranking[0].count} faltas registradas.`
                : 'No hay faltas registradas en el período evaluado.';

            return {
                parsed,
                title: 'Top 5 Empleados con Mayor Ausentismo',
                naturalAnswer: natural,
                kpis: [
                    { label: 'Líder en Faltas', value: ranking[0]?.name || 'N/A', color: '#EF4444' },
                    { label: 'Faltas del Líder', value: ranking[0]?.count || 0, color: '#EF4444' },
                    { label: 'Total Colaboradores con Falta', value: counts.size, color: '#F59E0B' }
                ],
                detailsType: 'ranking_list',
                data: ranking
            };
        }

        case 'TOP_LATE': {
            const counts = new Map<number, { count: number; minutes: number }>();
            for (let i = 0; i < attendanceRecords.length; i++) {
                const r = attendanceRecords[i];
                if (r.status === 'late') {
                    const existing = counts.get(r.employee_id) || { count: 0, minutes: 0 };
                    counts.set(r.employee_id, {
                        count: existing.count + 1,
                        minutes: existing.minutes + (r.minutes_late || 0)
                    });
                }
            }

            const ranking = Array.from(counts.entries())
                .map(([empId, data]) => {
                    const emp = employees.find(e => e.id === empId);
                    return {
                        id: empId,
                        code: emp?.employee_code || `EMP-${empId}`,
                        name: emp ? `${emp.first_name} ${emp.last_name}` : `Empleado ${empId}`,
                        dept: emp?.department_name || 'Sin departamento',
                        count: data.count,
                        minutes: data.minutes
                    };
                })
                .sort((a, b) => b.count - a.count)
                .slice(0, 5);

            return {
                parsed,
                title: 'Top 5 Empleados con Más Retardos',
                naturalAnswer: ranking.length > 0
                    ? `El colaborador con más retardos es ${ranking[0].name} (${ranking[0].code}) con ${ranking[0].count} incidencias y ${ranking[0].minutes} minutos acumulados.`
                    : 'No se registran retardos.',
                kpis: [
                    { label: 'Líder en Retardos', value: ranking[0]?.name || 'N/A', color: '#F59E0B' },
                    { label: 'Retardos Registrados', value: ranking[0]?.count || 0, color: '#F59E0B' },
                    { label: 'Minutos Demora', value: `${ranking[0]?.minutes || 0} min`, color: '#EF4444' }
                ],
                detailsType: 'ranking_list',
                data: ranking
            };
        }

        case 'TODAY_STATUS': {
            const todayStr = new Date().toISOString().split('T')[0];
            const todayRecords = attendanceRecords.filter(r => r.date === todayStr);
            const m = summarizeAttendance(todayRecords);

            return {
                parsed,
                title: 'Estado de Asistencia del Día de Hoy',
                naturalAnswer: `Hoy se registran ${m.present} presentes a tiempo, ${m.late} llegadas tarde y ${m.absent} ausencias de una plantilla evaluada de ${employees.length} colaboradores (${m.attendanceRate}% de asistencia global).`,
                kpis: [
                    { label: 'Presentes a Tiempo', value: m.present, color: '#10B981' },
                    { label: 'Llegadas Tarde', value: m.late, color: '#F59E0B' },
                    { label: 'Ausentes', value: m.absent, color: '#EF4444' },
                    { label: 'Tasa de Asistencia', value: `${m.attendanceRate}%`, color: '#3B82F6' }
                ],
                detailsType: 'records_table',
                data: todayRecords
            };
        }

        case 'DEPARTMENT_STATS': {
            const deptCounts = new Map<string, { total: number; present: number; absent: number; late: number }>();

            for (let i = 0; i < attendanceRecords.length; i++) {
                const r = attendanceRecords[i];
                const dept = r.department_name || 'General';
                const cur = deptCounts.get(dept) || { total: 0, present: 0, absent: 0, late: 0 };
                cur.total++;
                if (r.status === 'present') cur.present++;
                else if (r.status === 'absent') cur.absent++;
                else if (r.status === 'late') cur.late++;
                deptCounts.set(dept, cur);
            }

            const deptArray = Array.from(deptCounts.entries()).map(([dept, d]) => ({
                department: dept,
                ...d,
                rate: d.total > 0 ? (((d.present + d.late) / d.total) * 100).toFixed(1) : '0.0'
            }));

            return {
                parsed,
                title: 'Rendimiento de Asistencia por Departamentos',
                naturalAnswer: `Se analizaron ${deptArray.length} departamentos. El departamento con mayor volumen de inasistencias es ${deptArray.sort((a,b) => b.absent - a.absent)[0]?.department || 'N/A'}.`,
                kpis: [
                    { label: 'Departamentos Evaluados', value: deptArray.length, color: '#3B82F6' },
                    { label: 'Total Registros', value: attendanceRecords.length, color: '#10B981' }
                ],
                detailsType: 'department_grid',
                data: deptArray
            };
        }

        case 'GENERAL_METRICS':
        default: {
            const m = summarizeAttendance(attendanceRecords);
            return {
                parsed,
                title: 'Panorama General de Asistencia y Tiempo',
                naturalAnswer: `El sistema registra ${attendanceRecords.length} eventos históricos para ${employees.length} empleados activos. Se observa una tasa global de asistencia de ${m.attendanceRate}%, con ${m.absent} ausencias acumuladas y ${m.late} retardos.`,
                kpis: [
                    { label: 'Plantilla Activa', value: employees.length, color: '#3B82F6' },
                    { label: 'Tasa de Asistencia', value: `${m.attendanceRate}%`, color: '#10B981' },
                    { label: 'Total Inasistencias', value: m.absent, color: '#EF4444' },
                    { label: 'Total Retardos', value: m.late, color: '#F59E0B' }
                ],
                detailsType: 'none',
                data: m
            };
        }
    }
}

// ============================================================================
// AUXILIARES
// ============================================================================

function diffInMinutes(startHHMM: string, endHHMM: string): number {
    return Math.max(0, timeToMinutes(endHHMM) - timeToMinutes(startHHMM));
}

function getMostFrequentDay(dist: Record<string, number>): string {
    let topDay = 'Ninguno';
    let topVal = 0;
    for (const [day, count] of Object.entries(dist)) {
        if (count > topVal) {
            topVal = count;
            topDay = `${day} (${count})`;
        }
    }
    return topVal > 0 ? topDay : 'Sin faltas';
}

// ============================================================================
// EXPORTACIÓN A EXCEL (CSV CON FORMATO INTERNACIONAL Y BOM UTF-8)
// ============================================================================

/**
 * Genera contenido CSV compatible al 100% con Microsoft Excel en español (BOM UTF-8, delimitador ;)
 * para el Historial de Faltas de un empleado (mensual y semanal).
 */
export function exportAbsenceHistoryToCSV(history: EmployeeAbsenceHistoryResult): string {
    const lines: string[] = [];
    lines.push('REPORTE ANALÍTICO DE HISTORIAL DE FALTAS');
    lines.push(`Empleado;${history.employee.first_name} ${history.employee.last_name}`);
    lines.push(`Nómina / Matrícula;${history.employee.employee_code}`);
    lines.push(`Departamento;${history.employee.department_name || 'General'}`);
    lines.push(`Puesto;${history.employee.position || 'Colaborador'}`);
    lines.push(`Total Faltas Acumuladas;${history.totalAbsences}`);
    lines.push(`Meses con Inasistencias;${history.monthsWithAbsencesCount}`);
    lines.push(`Promedio Faltas / Mes;${history.averagePerMonth}`);
    lines.push(`Día Más Frecuente;${getMostFrequentDay(history.dayOfWeekDistribution)}`);
    lines.push(`Fecha de Emisión;${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('DESGLOSE DETALLADO DE INASISTENCIAS POR MES Y SEMANA');
    lines.push('Año-Mes;Mes;Semana;Día de la Semana;Fecha (YYYY-MM-DD);Notas / Justificación');

    for (let m = 0; m < history.months.length; m++) {
        const month = history.months[m];
        for (let w = 0; w < month.weeks.length; w++) {
            const week = month.weeks[w];
            for (let d = 0; d < week.days.length; d++) {
                const day = week.days[d];
                const cleanNote = (day.notes || '').replace(/;/g, ',').replace(/[\r\n]+/g, ' ');
                lines.push(`${month.monthKey};${month.monthName};${week.weekLabel};${day.dayOfWeek};${day.date};${cleanNote}`);
            }
        }
    }

    // BOM UTF-8 (\uFEFF) para que Excel reconozca tildes y caracteres especiales automáticamente
    return '\uFEFF' + lines.join('\r\n');
}

/**
 * Genera contenido CSV compatible con Excel para los resultados del Explorador Q&A.
 */
export function exportQAResultToCSV(result: DomainQueryResult): string {
    const lines: string[] = [];
    lines.push('REPORTE DE CONSULTA DE ASISTENCIA Y PERSONAL');
    lines.push(`Pregunta Formulada;${result.parsed.rawQuery}`);
    lines.push(`Intención Detectada;${result.parsed.intent}`);
    lines.push(`Resumen Ejecutivo;${result.naturalAnswer.replace(/;/g, ',').replace(/[\r\n]+/g, ' ')}`);
    lines.push(`Fecha de Emisión;${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('MÉTRICAS CLAVE (KPI)');
    lines.push('Indicador;Valor');
    for (let i = 0; i < result.kpis.length; i++) {
        const kpi = result.kpis[i];
        lines.push(`${kpi.label};${kpi.value}`);
    }

    if (result.detailsType === 'ranking_list' && Array.isArray(result.data)) {
        lines.push('');
        lines.push('RANKING DE AUSENTISMO');
        lines.push('Posición;Nómina;Empleado;Departamento;Total Faltas');
        result.data.forEach((item: any, idx: number) => {
            lines.push(`${idx + 1};${item.code};${item.name};${item.dept || ''};${item.count}`);
        });
    } else if (result.detailsType === 'records_table' && Array.isArray(result.data)) {
        lines.push('');
        lines.push('REGISTROS RELACIONADOS');
        lines.push('Fecha;Entrada;Salida;Estado;Minutos Tarde;Minutos Extra');
        result.data.forEach((r: any) => {
            lines.push(`${r.date};${r.check_in_time || ''};${r.check_out_time || ''};${r.status};${r.minutes_late || 0};${r.minutes_overtime || 0}`);
        });
    }

    return '\uFEFF' + lines.join('\r\n');
}
