# Backend — Empresa Paola

API REST construida con **Hono + Supabase + BullMQ + Zavu**.

## Stack

| Tecnología | Rol |
|---|---|
| [Hono](https://hono.dev) | Framework HTTP (TypeScript) |
| [Supabase](https://supabase.com) | Base de datos PostgreSQL + Auth + RLS |
| [BullMQ](https://bullmq.io) | Cola de notificaciones (Redis) |
| [Zavu](https://zavu.dev) | Mensajería unificada (WhatsApp / Email) |
| [tsx](https://github.com/privatenumber/tsx) | Dev server con hot-reload |
| [Vitest](https://vitest.dev) | Tests |

---

## Levantar en local

### Requisitos previos

| Herramienta | Versión mínima | Verificar |
|---|---|---|
| Node.js | 18+ | `node -v` |
| npm | 9+ | `npm -v` |
| Docker Desktop | cualquiera | `docker -v` |
| ngrok (opcional) | 3.4+ | `ngrok -v` |

---

### 1. Instalar dependencias

```bash
npm install
```

---

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con los valores reales:

```env
# Supabase — dashboard.supabase.com → Settings → API
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Zavu — app.zavu.dev → API Keys
ZAVU_API_KEY=zv_...
ZAVU_WEBHOOK_SECRET=whsec_...

# Configuración general
RS_TEAM_EMAIL=admin@tuempresa.com
PLATFORM_URL=http://localhost:3000
PORT=3000
NODE_ENV=development

# Redis (local)
REDIS_URL=redis://localhost:6379
```

---

### 3. Levantar Redis

```bash
docker run -d --name redis-paola -p 6379:6379 redis:alpine
```

Verificar que está corriendo:

```bash
docker ps   # debe aparecer redis-paola
```

| Comando | Descripción |
|---|---|
| `docker stop redis-paola` | Detener Redis |
| `docker start redis-paola` | Volver a iniciarlo |

---

### 4. Iniciar el servidor de desarrollo

```bash
npm run dev
```

Salida esperada:

```
[INFO] Servidor corriendo en http://localhost:3000
[INFO] Notification worker iniciado
```

El servidor recarga automáticamente al guardar cambios.

---

### 5. Verificar que todo funciona

**Health check:**

```bash
curl http://localhost:3000/health
# { "status": "ok", "ts": "..." }
```

**Login (obtener JWT):**

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"tu@email.com","password":"tuPassword"}'
# { "access_token": "eyJ...", "user": { ... } }
```

**Usar el token en peticiones protegidas:**

```bash
TOKEN="eyJ..."
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

---

### 6. (Opcional) Exponer el webhook con ngrok

Solo necesario para recibir eventos de Zavu en local.

```bash
ngrok http 3000
```

Ngrok mostrará una URL como `https://abc123.ngrok-free.app`. Registrarla en el dashboard de Zavu apuntando a:

```
https://abc123.ngrok-free.app/webhooks/zavu
```

> Actualizar `ZAVU_WEBHOOK_SECRET` en `.env` con el secreto generado por Zavu al crear el webhook, luego reiniciar el servidor.

---

### 7. Ejecutar tests

```bash
npm test
```

---

## Docker

### Solo Redis (recomendado para desarrollo)

Levanta únicamente Redis y corre la API con `npm run dev`:

```bash
docker compose -f docker-compose.dev.yml up -d
npm run dev
```

### Stack completo (API + Redis)

```bash
# Construir y levantar todo
docker compose up --build

# En segundo plano
docker compose up --build -d

# Ver logs
docker compose logs -f api

# Detener
docker compose down
```

> La API en el contenedor usa `NODE_ENV=production`. Asegúrate de que `.env` tenga todos los valores antes de levantar.

---

## Scripts disponibles

| Script | Descripción |
|---|---|
| `npm run dev` | Servidor con hot-reload |
| `npm run build` | Compilar TypeScript |
| `npm start` | Correr build de producción |
| `npm test` | Ejecutar tests |
| `npm run test:watch` | Tests en modo watch |

---

## Endpoints principales

### Públicos

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servidor |
| `POST` | `/auth/login` | Obtener JWT |
| `GET` | `/invitations/verify` | Verificar invitación |
| `POST` | `/invitations/accept` | Aceptar invitación |
| `POST` | `/api/onboarding` | Iniciar onboarding |
| `POST` | `/webhooks/zavu` | Webhook de Zavu |

### Protegidos (requieren `Authorization: Bearer <token>`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/auth/me` | Perfil del usuario autenticado |
| `GET` | `/api/profiles/me` | Perfil completo |
| `GET/POST` | `/api/companies` | Empresas |
| `GET/POST` | `/api/tasks` | Tareas |
| `POST` | `/api/tasks/generate` | Generar tareas (admin) |
| `GET/POST` | `/api/requests` | Solicitudes operativas |
| `GET/POST` | `/api/collection/debtors` | Deudores |
| `GET/POST` | `/api/collection/campaigns` | Campañas de cobranza |
| `GET/POST` | `/api/collection/templates` | Plantillas de mensajes |
| `GET/POST` | `/api/collection/actions` | Acciones de cobranza |
| `GET` | `/api/collection/messages` | Mensajes entrantes |
| `GET/POST` | `/api/services` | Servicios |
| `GET/POST` | `/api/policies` | Versiones de política |
| `GET/POST` | `/api/request-types` | Tipos de solicitud |
| `GET/POST` | `/api/dashboards` | Dashboards embebidos |
| `GET/POST` | `/api/company-services/:companyId` | Servicios por empresa |
| `GET/POST` | `/api/documents` | Documentos |

---

## Solución a problemas comunes

| Error | Causa | Solución |
|---|---|---|
| `Connection refused :6379` | Redis no está corriendo | `docker start redis-paola` |
| `Invalid API key` | `SUPABASE_SERVICE_ROLE_KEY` incorrecto | Supabase → Settings → API |
| `401 Credenciales inválidas` | Usuario no existe en Supabase Auth | Supabase → Authentication → Users |
| ngrok muestra página de advertencia | Falta header | Agregar `ngrok-skip-browser-warning: true` en las peticiones |
| `Cannot find module` | Falta compilación o dependencia | `npm install` y reiniciar |
