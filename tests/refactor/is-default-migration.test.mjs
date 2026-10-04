// T-N1 — Migración is_default en departments/shifts + reset seguro
// Verifica: (1) el seed marca is_default=1; (2) el ALTER TABLE agrega la columna
// en DBs pre-existentes; (3) resetDatabase con `WHERE is_default=0` borra solo personalizados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = fs.readFileSync(
    path.resolve('sistema-asistencia/database/schema.sql'),
    'utf-8'
);

function applySchemaToFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    return db;
}

test('is_default: fresh DB seed marca departments id<=5 con is_default=1', () => {
    const db = applySchemaToFreshDb();
    const rows = db.prepare('SELECT id, is_default FROM departments ORDER BY id').all();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(r => ({ id: r.id, def: r.is_default })), [
        { id: 1, def: 1 },
        { id: 2, def: 1 },
        { id: 3, def: 1 },
        { id: 4, def: 1 },
        { id: 5, def: 1 },
    ]);
});

test('is_default: fresh DB seed marca shifts id<=4 con is_default=1', () => {
    const db = applySchemaToFreshDb();
    const rows = db.prepare('SELECT id, is_default FROM shifts ORDER BY id').all();
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(r => ({ id: r.id, def: r.is_default })), [
        { id: 1, def: 1 },
        { id: 2, def: 1 },
        { id: 3, def: 1 },
        { id: 4, def: 1 },
    ]);
});

test('is_default: columnas existen en CREATE TABLE', () => {
    const db = applySchemaToFreshDb();
    const deptCols = db.prepare("PRAGMA table_info(departments)").all();
    const shiftCols = db.prepare("PRAGMA table_info(shifts)").all();
    assert.ok(deptCols.some(c => c.name === 'is_default'));
    assert.ok(shiftCols.some(c => c.name === 'is_default'));
});

test('resetDatabase WHERE is_default=0 borra solo personalizados', () => {
    const db = applySchemaToFreshDb();
    // Simular creación de dept personalizado
    db.prepare("INSERT INTO departments (name, description, is_default) VALUES ('Custom Dept', 'test', 0)").run();
    const before = db.prepare('SELECT COUNT(*) AS n FROM departments').get();
    assert.equal(before.n, 6);

    // Aplicar el query del reset (N1)
    const result = db.prepare('DELETE FROM departments WHERE is_default = 0').run();
    assert.equal(result.changes, 1);

    const after = db.prepare('SELECT COUNT(*) AS n FROM departments').get();
    assert.equal(after.n, 5);
});

test('migración ALTER TABLE: DB existente sin is_default -> agregar columna y marcar base', () => {
    // Simular una DB pre-N1: esquema sin is_default, sin la columna
    const OLD_SCHEMA_DEPT = `
        CREATE TABLE departments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT
        );
        INSERT INTO departments (id, name, description) VALUES
            (1, 'Recursos Humanos', 'RRHH'),
            (2, 'Tecnología', 'TI'),
            (3, 'Ventas', 'VTAS'),
            (4, 'Administración', 'ADM'),
            (5, 'Operaciones', 'OPS');
    `;
    const OLD_SCHEMA_SHIFT = `
        CREATE TABLE shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL
        );
        INSERT INTO shifts (id, name, start_time, end_time) VALUES
            (1, 'Matutino', '08:00', '16:00'),
            (2, 'Vespertino', '14:00', '22:00'),
            (3, 'Nocturno', '22:00', '06:00'),
            (4, 'Administrativo', '09:00', '18:00');
    `;
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_SCHEMA_DEPT);
    db.exec(OLD_SCHEMA_SHIFT);

    // Verificar pre-migración
    const preCols = db.prepare("PRAGMA table_info(departments)").all();
    assert.ok(!preCols.some(c => c.name === 'is_default'));

    // Aplicar ALTER TABLE (migración N1)
    db.exec('ALTER TABLE departments ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE shifts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');

    // Marcar base (lógica del migrateIsDefault: solo si total <= baseCount)
    const deptTotal = db.prepare('SELECT COUNT(*) AS n FROM departments').get().n;
    const shiftTotal = db.prepare('SELECT COUNT(*) AS n FROM shifts').get().n;
    assert.equal(deptTotal, 5);
    assert.equal(shiftTotal, 4);

    db.prepare('UPDATE departments SET is_default = 1 WHERE id <= 5').run();
    db.prepare('UPDATE shifts SET is_default = 1 WHERE id <= 4').run();

    // Post-migración: base marcada, column existe
    const depts = db.prepare('SELECT id, is_default FROM departments ORDER BY id').all();
    assert.ok(depts.every(d => d.is_default === 1));
    const shifts = db.prepare('SELECT id, is_default FROM shifts ORDER BY id').all();
    assert.ok(shifts.every(s => s.is_default === 1));

    // reset simulado: WHERE is_default=0 borra 0 filas (no hay personalizados)
    const r = db.prepare('DELETE FROM departments WHERE is_default = 0').run();
    assert.equal(r.changes, 0);
});

test('migración segura: DB con datos de usuario NO pisa is_default=0', () => {
    // Simular DB vieja con MUCHOS departamentos personalizados (no es fresh)
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        INSERT INTO departments (name) VALUES ('A'),('B'),('C'),('D'),('E'),('F'),('G');
    `);
    // ALTER TABLE (sin marcar porque total > baseCount)
    db.exec('ALTER TABLE departments ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');

    const total = db.prepare('SELECT COUNT(*) AS n FROM departments').get().n;
    // Logica del migrateIsDefault: si NO es columna recién agregada (ya existía), no marca.
    // Aqui la columna fue recién agregada pero total > 5 → NO marca
    const isJustAdded = true; // recien agregada
    const baseCount = 5;
    if (isJustAdded && total <= baseCount) {
        db.prepare('UPDATE departments SET is_default = 1 WHERE id <= ?').run(baseCount);
    }

    // Ninguna fila debe quedar como base — todas con is_default=0 (datos de usuario intactos)
    const rows = db.prepare('SELECT is_default FROM departments').all();
    assert.ok(rows.every(r => r.is_default === 0));
});