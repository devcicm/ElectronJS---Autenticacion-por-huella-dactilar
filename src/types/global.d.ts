export {};

declare global {
  interface Employee {
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

  interface Fingerprint {
    id?: number;
    employeeId: number;
    tag: string;
    hand: string;
    finger: string;
    template: string;
    format: string;
    enrolledAt?: string;
  }

  interface AttendanceRecord {
    id?: number;
    employeeId: number;
    recordType: 'ENTRY' | 'EXIT';
    recordedAt: string;
    fingerUsed?: string;
    notes?: string;
  }

  interface Window {
    employees: {
      getAll: (activeOnly?: boolean) => Promise<Employee[]>;
      getById: (id: number) => Promise<Employee | null>;
      create: (employee: Employee) => Promise<number>;
      update: (id: number, employee: Partial<Employee>) => Promise<boolean>;
      delete: (id: number) => Promise<boolean>;
    };

    fingerprints: {
      getByEmployee: (employeeId: number) => Promise<Fingerprint[]>;
      create: (fingerprint: Fingerprint) => Promise<number>;
    };

    attendance: {
      today: () => Promise<AttendanceRecord[]>;
      getByEmployee: (employeeId: number, limit?: number) => Promise<AttendanceRecord[]>;
    };

    stats: {
      get: () => Promise<{
        totalEmployees: number;
        todayAttendance: number;
        totalFingerprints: number;
      }>;
    };

    config: {
      get: () => Promise<{
        expressPort: number;
        biometricPort: number;
      }>;
    };
  }
}
