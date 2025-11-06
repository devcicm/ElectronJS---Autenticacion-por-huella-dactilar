import Database from 'better-sqlite3';
import path from 'node:path';
import { app } from 'electron';

export interface Employee {
  id?: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email?: string;
  position?: string;
  department?: string;
  photoUrl?: string;
  isActive: boolean;
  createdAt?: string;
}

export interface Fingerprint {
  id?: number;
  employeeId: number;
  tag: string;
  hand: string;
  finger: string;
  template: string;
  format: string;
  enrolledAt?: string;
}

export interface AttendanceRecord {
  id?: number;
  employeeId: number;
  recordType: 'ENTRY' | 'EXIT';
  recordedAt: string;
  fingerUsed?: string;
  notes?: string;
}

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const userDataPath = app.getPath('userData');
    const defaultPath = path.join(userDataPath, 'attendance.db');
    this.db = new Database(dbPath || defaultPath);
    this.initialize();
  }

  private initialize() {
    // Crear tabla de empleados
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_code TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT,
        position TEXT,
        department TEXT,
        photo_url TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Crear tabla de huellas dactilares
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        tag TEXT UNIQUE NOT NULL,
        hand TEXT NOT NULL,
        finger TEXT NOT NULL,
        template TEXT NOT NULL,
        format TEXT NOT NULL,
        enrolled_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        UNIQUE(employee_id, hand, finger)
      );
    `);

    // Crear tabla de registros de asistencia
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        record_type TEXT NOT NULL CHECK(record_type IN ('ENTRY', 'EXIT')),
        recorded_at TEXT DEFAULT (datetime('now')),
        finger_used TEXT,
        notes TEXT,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      );
    `);

    // Crear índices
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id);
      CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_fingerprints_employee ON fingerprints(employee_id);
      CREATE INDEX IF NOT EXISTS idx_fingerprints_tag ON fingerprints(tag);
    `);

    console.log('✅ Base de datos inicializada correctamente');
  }

  // ===== CRUD de Empleados =====

  createEmployee(employee: Employee): number {
    const stmt = this.db.prepare(`
      INSERT INTO employees (employee_code, first_name, last_name, email, position, department, photo_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      employee.employeeCode,
      employee.firstName,
      employee.lastName,
      employee.email || null,
      employee.position || null,
      employee.department || null,
      employee.photoUrl || null,
      employee.isActive ? 1 : 0
    );

    return result.lastInsertRowid as number;
  }

  getEmployeeById(id: number): Employee | null {
    const stmt = this.db.prepare(`
      SELECT id, employee_code as employeeCode, first_name as firstName, last_name as lastName,
             email, position, department, photo_url as photoUrl, is_active as isActive, created_at as createdAt
      FROM employees WHERE id = ?
    `);
    const result = stmt.get(id) as any;
    if (result) {
      result.isActive = result.isActive === 1;
    }
    return result || null;
  }

  getEmployeeByCode(code: string): Employee | null {
    const stmt = this.db.prepare(`
      SELECT id, employee_code as employeeCode, first_name as firstName, last_name as lastName,
             email, position, department, photo_url as photoUrl, is_active as isActive, created_at as createdAt
      FROM employees WHERE employee_code = ?
    `);
    const result = stmt.get(code) as any;
    if (result) {
      result.isActive = result.isActive === 1;
    }
    return result || null;
  }

  getAllEmployees(activeOnly: boolean = false): Employee[] {
    let query = `
      SELECT id, employee_code as employeeCode, first_name as firstName, last_name as lastName,
             email, position, department, photo_url as photoUrl, is_active as isActive, created_at as createdAt
      FROM employees
    `;

    if (activeOnly) {
      query += ' WHERE is_active = 1';
    }

    query += ' ORDER BY last_name, first_name';

    const stmt = this.db.prepare(query);
    const results = stmt.all() as any[];
    return results.map(r => ({ ...r, isActive: r.isActive === 1 }));
  }

  updateEmployee(id: number, employee: Partial<Employee>): boolean {
    const fields: string[] = [];
    const values: any[] = [];

    if (employee.firstName !== undefined) {
      fields.push('first_name = ?');
      values.push(employee.firstName);
    }
    if (employee.lastName !== undefined) {
      fields.push('last_name = ?');
      values.push(employee.lastName);
    }
    if (employee.email !== undefined) {
      fields.push('email = ?');
      values.push(employee.email);
    }
    if (employee.position !== undefined) {
      fields.push('position = ?');
      values.push(employee.position);
    }
    if (employee.department !== undefined) {
      fields.push('department = ?');
      values.push(employee.department);
    }
    if (employee.photoUrl !== undefined) {
      fields.push('photo_url = ?');
      values.push(employee.photoUrl);
    }
    if (employee.isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(employee.isActive ? 1 : 0);
    }

    if (fields.length === 0) return false;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);

    return result.changes > 0;
  }

  deleteEmployee(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM employees WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ===== CRUD de Huellas Dactilares =====

  createFingerprint(fingerprint: Fingerprint): number {
    const stmt = this.db.prepare(`
      INSERT INTO fingerprints (employee_id, tag, hand, finger, template, format)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      fingerprint.employeeId,
      fingerprint.tag,
      fingerprint.hand,
      fingerprint.finger,
      fingerprint.template,
      fingerprint.format
    );

    return result.lastInsertRowid as number;
  }

  getFingerprintsByEmployee(employeeId: number): Fingerprint[] {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, tag, hand, finger, template, format, enrolled_at as enrolledAt
      FROM fingerprints WHERE employee_id = ?
    `);
    return stmt.all(employeeId) as Fingerprint[];
  }

  getFingerprintByTag(tag: string): Fingerprint | null {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, tag, hand, finger, template, format, enrolled_at as enrolledAt
      FROM fingerprints WHERE tag = ?
    `);
    return stmt.get(tag) as Fingerprint || null;
  }

  getAllFingerprints(): Fingerprint[] {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, tag, hand, finger, template, format, enrolled_at as enrolledAt
      FROM fingerprints
    `);
    return stmt.all() as Fingerprint[];
  }

  deleteFingerprint(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM fingerprints WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteFingerprintsByEmployee(employeeId: number): number {
    const stmt = this.db.prepare('DELETE FROM fingerprints WHERE employee_id = ?');
    const result = stmt.run(employeeId);
    return result.changes;
  }

  // ===== CRUD de Registros de Asistencia =====

  createAttendanceRecord(record: AttendanceRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO attendance_records (employee_id, record_type, recorded_at, finger_used, notes)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      record.employeeId,
      record.recordType,
      record.recordedAt,
      record.fingerUsed || null,
      record.notes || null
    );

    return result.lastInsertRowid as number;
  }

  getAttendanceByEmployee(employeeId: number, limit: number = 50): AttendanceRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, record_type as recordType,
             recorded_at as recordedAt, finger_used as fingerUsed, notes
      FROM attendance_records
      WHERE employee_id = ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `);
    return stmt.all(employeeId, limit) as AttendanceRecord[];
  }

  getLastAttendanceByEmployee(employeeId: number): AttendanceRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, record_type as recordType,
             recorded_at as recordedAt, finger_used as fingerUsed, notes
      FROM attendance_records
      WHERE employee_id = ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `);
    return stmt.get(employeeId) as AttendanceRecord || null;
  }

  getAttendanceByDateRange(startDate: string, endDate: string): AttendanceRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, record_type as recordType,
             recorded_at as recordedAt, finger_used as fingerUsed, notes
      FROM attendance_records
      WHERE recorded_at BETWEEN ? AND ?
      ORDER BY recorded_at DESC
    `);
    return stmt.all(startDate, endDate) as AttendanceRecord[];
  }

  getTodayAttendance(): AttendanceRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, employee_id as employeeId, record_type as recordType,
             recorded_at as recordedAt, finger_used as fingerUsed, notes
      FROM attendance_records
      WHERE date(recorded_at) = date('now')
      ORDER BY recorded_at DESC
    `);
    return stmt.all() as AttendanceRecord[];
  }

  // ===== Utilidades =====

  close() {
    this.db.close();
  }

  // Método para insertar datos de prueba
  seedDemoData() {
    // Verificar si ya hay datos
    const count = this.db.prepare('SELECT COUNT(*) as count FROM employees').get() as any;
    if (count.count > 0) {
      console.log('ℹ️  Ya existen datos en la base de datos');
      return;
    }

    console.log('🌱 Insertando datos de prueba...');

    // Empleados de ejemplo
    const employees = [
      { employeeCode: 'EMP001', firstName: 'Juan', lastName: 'Pérez', email: 'juan.perez@empresa.com', position: 'Desarrollador', department: 'IT', isActive: true },
      { employeeCode: 'EMP002', firstName: 'María', lastName: 'González', email: 'maria.gonzalez@empresa.com', position: 'Diseñadora', department: 'Diseño', isActive: true },
      { employeeCode: 'EMP003', firstName: 'Carlos', lastName: 'Rodríguez', email: 'carlos.rodriguez@empresa.com', position: 'Gerente', department: 'Administración', isActive: true }
    ];

    for (const emp of employees) {
      this.createEmployee(emp);
    }

    console.log('✅ Datos de prueba insertados correctamente');
  }
}
