/**
 * Inicializador de Base de Datos SQLite
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DatabaseManager {
    private db: Database.Database | null = null;
    private dbPath: string;

    constructor(dbPath?: string) {
        // Por defecto, la BD se guarda en la carpeta del usuario
        this.dbPath = dbPath || path.join(process.cwd(), 'sistema-asistencia', 'database', 'attendance.db');
        console.log(`[Database] Ruta de BD: ${this.dbPath}`);
    }

    /**
     * Inicializar la base de datos
     */
    initialize(): void {
        try {
            // Crear directorio si no existe
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Abrir conexión a la base de datos
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging para mejor performance

            console.log('✅ Base de datos conectada');

            // Ejecutar el esquema (con foreign keys desactivadas temporalmente para evitar problemas de dependencias circulares)
            this.db.pragma('foreign_keys = OFF');
            this.executeSchema();
            this.runMigrations();
            this.db.pragma('foreign_keys = ON');  // Activar foreign keys después de crear el esquema

            console.log('✅ Esquema de base de datos creado/verificado');
        } catch (error) {
            console.error('❌ Error inicializando base de datos:', error);
            throw error;
        }
    }

    /**
     * Ejecutar el esquema SQL
     */
    private executeSchema(): void {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf-8');

        // Remover líneas de comentarios del schema completo
        const cleanedSchema = schema.split('\n')
            .filter(line => {
                const trimmed = line.trim();
                return trimmed.length > 0 && !trimmed.startsWith('--');
            })
            .join('\n');

        // Dividir el schema en statements individuales manejando BEGIN...END
        const statements: string[] = [];
        let currentStatement = '';
        let insideTrigger = false;

        // Recorrer carácter por carácter
        for (let i = 0; i < cleanedSchema.length; i++) {
            const char = cleanedSchema[i];
            currentStatement += char;

            // Detectar si estamos entrando en un TRIGGER
            if (!insideTrigger && /CREATE\s+TRIGGER/i.test(currentStatement)) {
                insideTrigger = true;
            }

            // Si encontramos un punto y coma
            if (char === ';') {
                // Si estamos en un trigger, buscar END; como finalizador
                if (insideTrigger) {
                    // Verificar si el statement termina con END;
                    const trimmed = currentStatement.trim();
                    if (/END\s*;$/i.test(trimmed)) {
                        statements.push(trimmed);
                        currentStatement = '';
                        insideTrigger = false;
                    }
                } else {
                    // No estamos en un trigger, este ; marca el fin del statement
                    const trimmed = currentStatement.trim();
                    if (trimmed.length > 0) {
                        statements.push(trimmed);
                    }
                    currentStatement = '';
                }
            }
        }

        // Agregar el último statement si existe
        const trimmed = currentStatement.trim();
        if (trimmed.length > 0) {
            statements.push(trimmed);
        }

        for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            console.log(`[${i+1}/${statements.length}] Ejecutando:`, statement.substring(0, 80) + '...');
            try {
                this.db!.prepare(statement).run();
                console.log(`[${i+1}/${statements.length}] ✅ OK`);
            } catch (error: any) {
                // Ignorar errores de "ya existe" (tabla, vista, trigger, etc.)
                if (!error.message.includes('already exists')) {
                    console.error('❌ Error ejecutando statement:');
                    console.error('Statement:', statement);
                    console.error('Error:', error.message);
                    throw error;
                }
            }
        }
    }

    /**
     * Ejecutar migraciones de base de datos
     */
    private runMigrations(): void {
        if (!this.db) return;

        console.log('🔄 Ejecutando migraciones de base de datos...');

        try {
            // Verificar si la columna enrollment_mode existe en la tabla employees
            const tableInfo = this.db.prepare("PRAGMA table_info(employees)").all() as Array<{name: string}>;
            const hasEnrollmentMode = tableInfo.some(col => col.name === 'enrollment_mode');

            if (!hasEnrollmentMode) {
                console.log('  📝 Agregando columna enrollment_mode a tabla employees...');
                this.db.prepare(`
                    ALTER TABLE employees
                    ADD COLUMN enrollment_mode TEXT DEFAULT 'simple'
                    CHECK(enrollment_mode IN ('simple', 'advanced'))
                `).run();
                console.log('  ✅ Columna enrollment_mode agregada exitosamente');
            } else {
                console.log('  ✅ Columna enrollment_mode ya existe');
            }

        } catch (error: any) {
            console.error('❌ Error ejecutando migraciones:', error.message);
            throw error;
        }

        console.log('✅ Migraciones completadas');
    }

    /**
     * Obtener la instancia de la base de datos
     */
    getDatabase(): Database.Database {
        if (!this.db) {
            throw new Error('Base de datos no inicializada. Llama a initialize() primero.');
        }
        return this.db;
    }

    /**
     * Cerrar la conexión a la base de datos
     */
    close(): void {
        if (this.db) {
            this.db.close();
            console.log('🔌 Base de datos cerrada');
            this.db = null;
        }
    }

    /**
     * Verificar si la base de datos está conectada
     */
    isConnected(): boolean {
        return this.db !== null;
    }

    /**
     * Ejecutar una consulta SELECT
     */
    query<T = any>(sql: string, params: any[] = []): T[] {
        if (!this.db) {
            throw new Error('Base de datos no inicializada');
        }

        try {
            return this.db.prepare(sql).all(...params) as T[];
        } catch (error) {
            console.error('Error en query:', sql, params, error);
            throw error;
        }
    }

    /**
     * Ejecutar una consulta que devuelve una sola fila
     */
    queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
        if (!this.db) {
            throw new Error('Base de datos no inicializada');
        }

        try {
            return this.db.prepare(sql).get(...params) as T | undefined;
        } catch (error) {
            console.error('Error en queryOne:', sql, params, error);
            throw error;
        }
    }

    /**
     * Ejecutar una consulta INSERT, UPDATE, DELETE
     */
    execute(sql: string, params: any[] = []): Database.RunResult {
        if (!this.db) {
            throw new Error('Base de datos no inicializada');
        }

        try {
            return this.db.prepare(sql).run(...params);
        } catch (error) {
            console.error('Error en execute:', sql, params, error);
            throw error;
        }
    }

    /**
     * Ejecutar múltiples statements en una transacción
     */
    transaction(callback: () => void): void {
        if (!this.db) {
            throw new Error('Base de datos no inicializada');
        }

        const transaction = this.db.transaction(callback);
        transaction();
    }
}

// Instancia singleton
let dbManager: DatabaseManager | null = null;

/**
 * Obtener la instancia del DatabaseManager
 */
export function getDatabaseManager(): DatabaseManager {
    if (!dbManager) {
        dbManager = new DatabaseManager();
        dbManager.initialize();
    }
    return dbManager;
}

/**
 * Cerrar la base de datos al finalizar
 */
export function closeDatabaseManager(): void {
    if (dbManager) {
        dbManager.close();
        dbManager = null;
    }
}
