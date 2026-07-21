# Voxia — Backend

API REST en Node.js + Express, multi-tenant, que administra clientes (organizaciones), campañas, contactos y llamadas, y expone los webhooks que consumen los proveedores de telefonía (Twilio y SIP nativo de OpenAI).

## Instalación

```bash
cp .env.example .env    # completa las variables (ver más abajo)
npm install
npm run db:init           # crea la base de datos "voxia", sus tablas, y el usuario admin sembrado
npm run dev                # arranca con nodemon en http://localhost:4000
```

`npm start` arranca sin nodemon, para producción.

## Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `PORT`, `PUBLIC_BASE_URL` | Puerto local y URL pública del backend (usada para construir los webhooks que Twilio/OpenAI deben llamar) |
| `CORS_ORIGIN` | Origen permitido para el frontend. En producción, apunta al dominio real (no dejar `*`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Credenciales de MySQL |
| `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE_DEFAULT` | Credenciales y configuración por defecto de la API Realtime de OpenAI |
| `TELEPHONY_PROVIDERS` | Proveedores habilitados a nivel de instancia, separados por coma: `twilio_realtime`, `openai_native_sip`. El proveedor real de cada cliente se elige por organización (ver más abajo), no aquí |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Necesarias solo si `twilio_realtime` está habilitado |
| `OPENAI_SIP_WEBHOOK_SECRET` | Necesaria solo si `openai_native_sip` está habilitado — secreto compartido que valida el webhook (header `X-Voxia-Sip-Secret`) |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Firma de los tokens de sesión. `JWT_SECRET` es obligatorio (el backend no arranca sin él) — genera uno con `openssl rand -hex 32` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Usuario admin creado automáticamente (si no existe) al correr `npm run db:init`. Es la cuenta con la que entras la primera vez |

## Autenticación y multi-tenancy

Voxia es multi-tenant: cada cliente es una **organización**, y cada usuario pertenece a una organización (o a ninguna, si es admin). Dos roles:

- **`admin`** (el vendedor/operador de Voxia) — `organization_id = NULL`, ve y administra todas las organizaciones.
- **`client`** — pertenece a una organización, solo ve y gestiona sus propios datos (campañas, contactos, llamadas, costos).

El admin da de alta cada cliente desde `POST /api/v1/organizations` (nombre + **un proveedor de telefonía fijo**, asignado una sola vez) y le crea credenciales de acceso con `POST /api/v1/organizations/:id/users`. El cliente nunca se auto-registra ni elige su proveedor de telefonía.

Autenticación por JWT (`Authorization: Bearer <token>`, `POST /api/v1/auth/login`, expira en `JWT_EXPIRES_IN`, sin refresh token — al expirar, se vuelve a iniciar sesión). El scoping por organización se aplica en cada controller vía `assertOrgAccess` (`src/middleware/auth.js`): un `client` que intenta acceder a un recurso de otra organización recibe `403`.

## Arquitectura de base de datos

Cinco tablas (ver `src/db/schema.sql`):

- **`organizations`** — cada cliente. Nombre + `telephony_provider` fijo (`twilio_realtime` o `openai_native_sip`).
- **`users`** — email, hash de contraseña, rol (`admin`/`client`), `organization_id` (`NULL` para admins).
- **`campaigns`** — nombre, tipo (`cobranza`, `ventas`, ...), `organization_id`, voz del agente, **idioma** (`es`/`en`, determina tanto el estilo de conversación del agente como el formato de moneda), plantilla de instrucciones (`system_prompt_template`, con placeholders `{{full_name}}`, `{{phone_number}}`, `{{balance_due}}`), estado. `telephony_provider` es un **espejo** de `organizations.telephony_provider`, copiado server-side al crear la campaña (`campaignController.create`) — nunca se escribe desde otro lugar.
- **`contacts`** — número, nombre, saldo pendiente, `extra_data` (JSON libre por campaña), estado de gestión (`pending`, `calling`, `completed`, `no_answer`, ...), intentos.
- **`call_logs`** — una fila por llamada: proveedor usado, id externo (Call SID de Twilio o call_id de OpenAI), estado, desenlace (`outcome`), duración, tokens/costo estimado, transcripción.

## Arquitectura de telefonía: patrón Adapter/Provider

El núcleo del negocio (`src/services/callOrchestrator.js`, `src/services/promptBuilder.js`, y los modelos) **no importa ningún SDK de telefonía**. Solo conoce la interfaz `TelephonyProvider` (`src/services/telephony/TelephonyProvider.js`):

- `initiateOutboundCall({ contact, campaign, callLog })` — origina una llamada saliente. Solo lo implementan proveedores "activos".
- `parseIncomingCallPayload(rawBody)` — extrae el contacto/id de llamada de un webhook entrante. Solo lo implementan proveedores "pasivos".
- `mapStatusEvent(rawEvent)` — normaliza un evento de estado propio del proveedor al set interno de estados de `call_logs`.

Implementaciones concretas:

- **`twilioRealtimeProvider.js`** (activo) — origina la llamada vía la API REST de Twilio. El audio se transporta con Twilio Media Streams (WebSocket) y se reenvía a la API Realtime de OpenAI en `src/ws/twilioMediaStreamHandler.js`.
- **`openaiSipProvider.js`** (pasivo) — el troncal SIP del call center llama a OpenAI directamente; OpenAI invoca `POST /api/v1/webhooks/openai/incoming?organizationId=X` en Voxia para pedir la configuración de la sesión. El `organizationId` en la URL es lo que evita que dos clientes con un contacto que comparte número de teléfono se crucen — la URL exacta (con el id de cada cliente) se muestra en el panel `/clientes` del frontend al crear una organización con este proveedor.

`src/services/telephony/providerFactory.js` instancia solo los proveedores listados en `TELEPHONY_PROVIDERS`. Cada organización declara qué proveedor usa, y el backend valida que esté habilitado antes de crearla.

> **Nota**: el contrato exacto del payload del webhook SIP nativo de OpenAI (nombres de campos, forma de la respuesta) está implementado según la especificación funcional del MVP, pero es una superficie de API nueva — verificar contra la documentación vigente de OpenAI antes de conectar un troncal real en producción.

## Endpoints

Todo bajo `/api/v1`. Todo excepto `/auth/login` y `/webhooks/*` requiere `Authorization: Bearer <token>`.

### Auth
- `POST /auth/login` — `{ email, password }` → `{ token, user }`. Rate-limited (10 intentos / 15 min por IP)
- `GET /auth/me` — restaura la sesión

### Organizaciones (solo `admin`)
- `POST /organizations` — `{ name, telephonyProvider }`
- `GET /organizations` — lista con conteo de campañas
- `POST /organizations/:id/users` — crea un usuario `client` para ese cliente, devuelve la contraseña temporal (una sola vez)
- `GET /organizations/:id/users` — lista usuarios de esa organización
- `POST /organizations/:id/users/:userId/reset-password` — genera una contraseña nueva

### Campañas y contactos (scoped por organización)
- `POST /campaigns` — `telephonyProvider` se ignora si viene en el body; siempre se copia de la organización. Un `client` no puede elegir `organizationId` (se toma de su sesión); un `admin` debe pasarlo
- `GET /campaigns` — un `client` ve solo las suyas; un `admin` ve todas o filtra con `?organizationId=`
- `GET /campaigns/:id`, `PATCH /campaigns/:id/status`, `POST /campaigns/:id/launch`
- `POST /campaigns/:campaignId/contacts/bulk`, `GET /campaigns/:campaignId/contacts`
- `PATCH /contacts/:id/status`

### Llamadas (scoped por organización)
- `GET /calls/live`, `GET /calls/metrics`, `GET /calls`, `GET /calls/:id`

### Webhooks (públicos — los invoca Twilio/OpenAI, no un usuario logueado)
- `POST /webhooks/openai/incoming?organizationId=X` — requiere header `X-Voxia-Sip-Secret`
- `POST /webhooks/twilio/voice`, `POST /webhooks/twilio/status` — validan firma de Twilio (`twilio.validateRequest`) solo en `NODE_ENV=production`
- `WS /webhooks/twilio/stream` — Media Stream de Twilio, montado sobre el mismo puerto HTTP en `server.js`

## Estructura de carpetas

```
src/
├── config/       env.js, db.js
├── db/           schema.sql, init.js (incluye el seed del admin)
├── middleware/   auth.js (authenticate, requireAdmin, assertOrgAccess)
├── models/       acceso a datos (mysql2)
├── services/
│   ├── promptBuilder.js       construye las instrucciones del agente (transporte-agnóstico). Combina un
│   │                          bloque fijo de estilo de conversación por idioma (natural, no robótico —
│   │                          ver DELIVERY_STYLE_INSTRUCTIONS_ES/EN, no editable desde el panel) con el
│   │                          guion propio de cada campaña (system_prompt_template, sí editable)
│   ├── callOrchestrator.js    lógica de negocio de campañas/llamadas (transporte-agnóstico)
│   └── telephony/             interfaz TelephonyProvider + adaptadores + factory
├── controllers/  handlers HTTP (callController.js = supervisor/protegido; webhookController.js = público)
├── routes/       definición de rutas Express
├── ws/           puente de audio Twilio Media Streams <-> OpenAI Realtime
└── utils/        httpError.js, asyncHandler.js
```
