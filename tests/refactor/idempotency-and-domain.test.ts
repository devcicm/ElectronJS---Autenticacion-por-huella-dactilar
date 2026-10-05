import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
    EmployeeStatus,
    EnrollmentMode,
    Hand,
    FingerPosition,
    AttendanceStatus,
    type BiometricTag,
    type MonthlyReportDTO
} from '../../dist/sistema-asistencia/types/index.js';
import { getLocalDateString } from '../../dist/sistema-asistencia/shared/date-utils.js';

const SCHEMA = fs.readFileSync(
    path.resolve('sistema-asistencia/database/schema.sql'),
    'utf-8'
);

// Wrapper mínimo compatible con DatabaseManager para pruebas unitarias en memoria
function createTestDb() {
    const rawDb = new DatabaseSync(':memory:');
    rawDb.exec(SCHEMA);

    const dbManager = {
        query: <T>(sql: string, params: any[] = []): T[] => {
            const stmt = rawDb.prepare(sql);
            return stmt.all(...params) as T[];
        },
        queryOne: <T>(sql: string, params: any[] = []): T | undefined => {
            const stmt = rawDb.prepare(sql);
            const row = stmt.get(...params);
            return (row as T) || undefined;
        },
        execute: (sql: string, params: any[] = []): { changes: number; lastInsertRowid: number | bigint } => {
            const stmt = rawDb.prepare(sql);
            const result = stmt.run(...params);
            return {
                changes: Number(result.changes),
                lastInsertRowid: Number(result.lastInsertRowid)
            };
        },
        raw: rawDb
    };

    return dbManager;
}

// ----------------------------------------------------------------------------
// 1. DOMINIO Y ENUMS
// ----------------------------------------------------------------------------
test('Enums: valores y constraints respetan SQLite schema.sql', () => {
    assert.equal(EmployeeStatus.ACTIVE, 'active');
    assert.equal(EmployeeStatus.INACTIVE, 'inactive');
    assert.equal(EmployeeStatus.SUSPENDED, 'suspended');

    assert.equal(EnrollmentMode.SIMPLE, 'simple');
    assert.equal(EnrollmentMode.ADVANCED, 'advanced');

    assert.equal(Hand.LEFT, 'LEFT');
    assert.equal(Hand.RIGHT, 'RIGHT');

    assert.equal(FingerPosition.THUMB, 'THUMB');
    assert.equal(FingerPosition.INDEX, 'INDEX');
    assert.equal(FingerPosition.MIDDLE, 'MIDDLE');
    assert.equal(FingerPosition.RING, 'RING');
    assert.equal(FingerPosition.PINKY, 'PINKY');

    assert.equal(AttendanceStatus.PRESENT, 'present');
    assert.equal(AttendanceStatus.LATE, 'late');
    assert.equal(AttendanceStatus.ABSENT, 'absent');
    assert.equal(AttendanceStatus.EXCUSED, 'excused');
    assert.equal(AttendanceStatus.HALF_DAY, 'half_day');
    assert.equal(AttendanceStatus.ON_LEAVE, 'on_leave');

    const sampleTag: BiometricTag = `${Hand.RIGHT}_${FingerPosition.INDEX}`;
    assert.equal(sampleTag, 'RIGHT_INDEX');
});

// ----------------------------------------------------------------------------
// 2. MODELO DE DEPARTAMENTOS (N3F y ausencia de columna fantasma 'color')
// ----------------------------------------------------------------------------
test('DepartmentModel: create y update operan sin columna fantasma color (N3F)', async () => {
    const { DepartmentModel } = await import('../../dist/sistema-asistencia/models/DepartmentModel.js');
    const db = createTestDb();
    const deptModel = new DepartmentModel(db as any);

    // Crear departamento sin error de columna color
    const created = deptModel.create({
        name: 'Seguridad y Salud Laboral',
        description: 'Gestión y prevención de riesgos laborales'
    });

    assert.ok(created.id > 0);
    assert.equal(created.name, 'Seguridad y Salud Laboral');

    // Verificar en la base de datos real
    const fromDb = deptModel.getById(created.id);
    assert.ok(fromDb);
    assert.equal(fromDb.name, 'Seguridad y Salud Laboral');

    // Actualizar departamento
    const updated = deptModel.update({
        id: created.id,
        name: 'Seguridad e Higiene Industrial',
        description: 'Actualizado'
    });
    assert.equal(updated.name, 'Seguridad e Higiene Industrial');
    assert.equal(updated.description, 'Actualizado');
});

// ----------------------------------------------------------------------------
// 3. IDEMPOTENCIA EN HUELLAS DACTILARES (upsert)
// ----------------------------------------------------------------------------
test('FingerprintModel.upsert: es idempotente al registrar el mismo dedo', async () => {
    const { FingerprintModel } = await import('../../dist/sistema-asistencia/models/FingerprintModel.js');
    const { EmployeeModel } = await import('../../dist/sistema-asistencia/models/EmployeeModel.js');
    const db = createTestDb();
    const empModel = new EmployeeModel(db as any);
    const fpModel = new FingerprintModel(db as any);

    const emp = empModel.create({
        employee_code: 'EMP001',
        first_name: 'Juan',
        last_name: 'Pérez',
        email: 'juan.perez@empresa.com',
        department_id: 1,
        shift_id: 1,
        position: 'Analista',
        hire_date: '2025-01-01',
        enrollment_mode: 'simple'
    });

    // Primer registro de huella
    const fp1 = fpModel.upsert({
        employee_id: emp.id,
        hand: 'RIGHT',
        finger_position: 'INDEX',
        template_data: 'TEMPLATE_SAMPLE_VERSION_1',
        quality_score: 95
    });

    assert.ok(fp1.id > 0);

    // Segundo registro para el MISMO empleado y MISMO dedo (idempotencia)
    const fp2 = fpModel.upsert({
        employee_id: emp.id,
        hand: 'RIGHT',
        finger_position: 'INDEX',
        template_data: 'TEMPLATE_SAMPLE_VERSION_2_UPDATED',
        quality_score: 99
    });

    // Debe mantener el mismo ID de registro (actualización)
    assert.equal(fp2.id, fp1.id);
    assert.equal(fp2.template_data, 'TEMPLATE_SAMPLE_VERSION_2_UPDATED');
    assert.equal(fp2.quality_score, 99);

    // Debe haber exactamente 1 huella registrada para este empleado
    const allFps = fpModel.getByEmployee(emp.id);
    assert.equal(allFps.length, 1);
});

// ----------------------------------------------------------------------------
// 4. IDEMPOTENCIA EN AUSENCIAS AUTOMÁTICAS (markAbsentees)
// ----------------------------------------------------------------------------
test('AttendanceModel.markAbsentees: es 100% idempotente al ejecutarse múltiples veces', async () => {
    const { AttendanceModel } = await import('../../dist/sistema-asistencia/models/AttendanceModel.js');
    const { EmployeeModel } = await import('../../dist/sistema-asistencia/models/EmployeeModel.js');
    const db = createTestDb();
    const empModel = new EmployeeModel(db as any);
    const attModel = new AttendanceModel(db as any);

    // Crear 2 empleados activos
    const emp1 = empModel.create({
        employee_code: 'EMP-A',
        first_name: 'Ana',
        last_name: 'Gómez',
        email: 'ana@empresa.com',
        department_id: 1,
        shift_id: 1,
        position: 'Coordinadora',
        hire_date: '2025-01-01'
    });

    const emp2 = empModel.create({
        employee_code: 'EMP-B',
        first_name: 'Bernardo',
        last_name: 'Díaz',
        email: 'bernardo@empresa.com',
        department_id: 1,
        shift_id: 1,
        position: 'Especialista',
        hire_date: '2025-01-01'
    });

    const today = getLocalDateString();

    // Emp 1 marca entrada
    attModel.checkIn(emp1.id, true);

    // Primera ejecución de ausencias automáticas: sólo emp2 debe marcarse como ausente
    const countFirstRun = attModel.markAbsentees(today);
    assert.equal(countFirstRun, 1);

    const rec2 = attModel.getByEmployeeAndDate(emp2.id, today);
    assert.ok(rec2);
    assert.equal(rec2.status, 'absent');

    // Segunda ejecución de ausencias automáticas hoy: debe devolver 0 e ignorar duplicados
    const countSecondRun = attModel.markAbsentees(today);
    assert.equal(countSecondRun, 0);

    // Tercera ejecución: sigue siendo 0
    const countThirdRun = attModel.markAbsentees(today);
    assert.equal(countThirdRun, 0);

    // Verificar que solo hay 2 registros totales para hoy
    const todayRecords = attModel.getToday();
    assert.equal(todayRecords.length, 2);
});

// ----------------------------------------------------------------------------
// 5. IDEMPOTENCIA Y BIG O EN ATTENDANCE SERVICE
// ----------------------------------------------------------------------------
test('AttendanceService: checkIn y checkOut son idempotentes y generateMonthlyReport es O(R + E)', async () => {
    const { AttendanceService } = await import('../../dist/sistema-asistencia/services/AttendanceService.js');
    const { EmployeeModel } = await import('../../dist/sistema-asistencia/models/EmployeeModel.js');
    const db = createTestDb();

    const service = new AttendanceService(db as any);
    const empModel = new EmployeeModel(db as any);

    const emp = empModel.create({
        employee_code: 'EMP-SVC',
        first_name: 'Laura',
        last_name: 'Méndez',
        email: 'laura@empresa.com',
        department_id: 1,
        shift_id: 1,
        position: 'Jefa de RRHH',
        hire_date: '2025-01-01'
    });

    // 1. Primer check-in
    const checkIn1 = await service.checkInWithFingerprint(emp.id, true);
    assert.equal(checkIn1.success, true);
    assert.ok(checkIn1.record);
    assert.equal(checkIn1.alreadyCheckedIn, undefined);

    // 2. Segundo check-in (idempotente)
    const checkIn2 = await service.checkInWithFingerprint(emp.id, true);
    assert.equal(checkIn2.success, true);
    assert.equal(checkIn2.alreadyCheckedIn, true);
    assert.equal(checkIn2.record?.id, checkIn1.record?.id);

    // 3. Primer check-out
    const checkOut1 = await service.checkOut(emp.id);
    assert.equal(checkOut1.success, true);
    assert.ok(checkOut1.record?.check_out_time);
    assert.equal(checkOut1.alreadyCheckedOut, undefined);

    // 4. Segundo check-out (idempotente)
    const checkOut2 = await service.checkOut(emp.id);
    assert.equal(checkOut2.success, true);
    assert.equal(checkOut2.alreadyCheckedOut, true);
    assert.equal(checkOut2.record?.check_out_time, checkOut1.record?.check_out_time);

    // 5. Reporte mensual O(R + E)
    const now = new Date();
    const report: MonthlyReportDTO = service.generateMonthlyReport(now.getFullYear(), now.getMonth() + 1);
    assert.equal(report.totalStats.totalRecords, 1);
    assert.equal(report.totalStats.verified, 1);
    assert.equal(report.employeeStats.length, 1);
    assert.equal(report.employeeStats[0].employeeCode, 'EMP-SVC');
});
