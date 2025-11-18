# Dockerfile para Sistema de Asistencia con Huella Dactilar
# Nota: Esta configuración es principalmente para desarrollo/testing
# El acceso a hardware USB (lector de huellas) requiere configuración adicional

FROM node:18-bullseye

# Instalar dependencias del sistema para Electron
RUN apt-get update && apt-get install -y \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libxcb-dri3-0 \
    libasound2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxrandr2 \
    libglib2.0-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Compilar TypeScript
RUN npm run build || npx tsc || true

# Crear directorio para base de datos
RUN mkdir -p /app/sistema-asistencia/database

# Exponer puerto para desarrollo
EXPOSE 5173 3000

# Variables de entorno
ENV NODE_ENV=development
ENV DISPLAY=:99

# Comando por defecto
CMD ["npm", "start"]
