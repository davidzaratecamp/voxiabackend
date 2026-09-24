# Reenviar un número de Twilio a un celular personal

Procedimiento para tomar un número de Twilio (de cualquier pool/organización en la
cuenta) y desviar sus llamadas y SMS entrantes a un celular personal — típico caso
de uso: recibir un código de verificación (OTP) de un servicio externo (Meta, etc.)
que lo manda por voz o SMS a ese número.

No es una función expuesta en el panel de Voxia — se hace a mano contra la API de
Twilio, apoyándose en dos webhooks que ya existen en el backend de Voxia.

## Cómo funciona

Cada número de Twilio tiene dos campos configurables: **Voice URL** (qué hacer
cuando entra una llamada) y **SMS URL** (qué hacer cuando entra un SMS). Twilio le
hace un `POST` a esa URL con cada evento y espera de vuelta TwiML.

El backend de Voxia (`src/controllers/webhookController.js`) ya tiene dos endpoints
para esto:

- `POST /api/v1/webhooks/twilio/forward/voice` → responde `<Dial>{FORWARD_TO_NUMBER}</Dial>`
- `POST /api/v1/webhooks/twilio/forward/sms` → responde `<Message to="{FORWARD_TO_NUMBER}">...</Message>`

`FORWARD_TO_NUMBER` es una variable de entorno en el `.env` de producción de Voxia
(hoy: `+573150184591`). Cambiarla no requiere tocar código, solo editar el `.env` y
reiniciar el proceso (`pm2 restart voxia-backend`).

Configurar el Voice/SMS URL de un número **no afecta** su uso para llamadas
salientes (el `from` de una campaña, o cualquier dialer saliente) — son cosas
independientes en Twilio. Sí afecta cualquier llamada/SMS que le llegue.

## Antes de elegir un número

**No cualquier número sirve igual de bien.** Verificar dos cosas antes de tocarlo:

1. **Que no lo esté usando otro sistema.** Revisar su `voiceUrl`/`smsUrl` actual en
   Twilio — si no es el default (`https://demo.twilio.com/welcome/voice/` y
   `.../sms/reply`), alguien ya lo configuró para algo (otra plataforma, otro
   proyecto) y no se debe tocar sin confirmar primero.
2. **Que esté "limpio" (sin historial de llamadas/SMS).** Un número con actividad
   saliente reciente (ráfagas de llamadas cortas a números distintos, típico de un
   dialer/campaña) puede quedar marcado como spam/robocall por los sistemas
   antifraude de servicios como Meta — el servicio simplemente no manda el código
   de verificación a ese número, **sin ningún rastro en los logs de Twilio** (no es
   un fallo de configuración, es que el otro lado ni siquiera intenta el envío).
   Preferir siempre un número sin ningún historial.

Query para revisar candidatos (contra la cuenta de Twilio de la organización, ver
sección de comandos abajo): filtrar por `voiceUrl`/`smsUrl` en default, y cruzar
contra el historial de llamadas/SMS de la cuenta para confirmar cero actividad.

## Configurar el reenvío

Requiere el `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` de la organización dueña del
número — están guardados en la BD de Voxia (`organizations.twilio_account_sid` /
`twilio_auth_token`), nunca en texto plano en ningún `.env`. Se consultan desde el
propio servidor de Voxia (root@2.25.209.166), donde también corre el backend con
acceso a esa base de datos.

```bash
ssh root@2.25.209.166 'cd /var/www/voxiabackend && node -e "
const mysql = require(\"mysql2/promise\");
const twilio = require(\"twilio\");
require(\"dotenv\").config();
(async () => {
  const conn = await mysql.createConnection({host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME});
  const [rows] = await conn.query(\"SELECT twilio_account_sid, twilio_auth_token FROM organizations WHERE id = 5\");
  const { twilio_account_sid, twilio_auth_token } = rows[0];
  const client = twilio(twilio_account_sid, twilio_auth_token);
  const numbers = await client.incomingPhoneNumbers.list({phoneNumber: \"+1XXXXXXXXXX\"});
  if (numbers.length === 0) { console.error(\"NUMERO NO ENCONTRADO EN TWILIO\"); process.exit(1); }
  const updated = await client.incomingPhoneNumbers(numbers[0].sid).update({
    voiceUrl: \"https://api.voxia.online/api/v1/webhooks/twilio/forward/voice?organizationId=5\",
    voiceMethod: \"POST\",
    smsUrl: \"https://api.voxia.online/api/v1/webhooks/twilio/forward/sms?organizationId=5\",
    smsMethod: \"POST\",
  });
  console.log(\"OK\", updated.sid, updated.phoneNumber, updated.voiceUrl, updated.smsUrl);
  await conn.end();
})().catch(e => { console.error(\"ERROR:\", e.message); process.exit(1); });
"'
```

Reemplazar `+1XXXXXXXXXX` por el número real y `organizationId=5` si algún día se usa
un número de otra organización (el id identifica de qué cuenta Twilio es, para que
`verifyTwilioSignature` valide con el auth token correcto).

## Probar

Llamar o mandar un SMS al número desde otro teléfono y confirmar que llega al
celular personal. Para verificar sin depender de que llegue de verdad, revisar los
logs de Twilio (mismo patrón de script que arriba, usando `client.calls.list()` /
`client.messages.list({to: numero})`).

## Revertir (dejar el número como estaba)

Importante hacerlo apenas se deja de necesitar el reenvío, sobre todo si el número
pertenece o puede llegar a pertenecer a otro proyecto/persona:

```bash
ssh root@2.25.209.166 'cd /var/www/voxiabackend && node -e "
const mysql = require(\"mysql2/promise\");
const twilio = require(\"twilio\");
require(\"dotenv\").config();
(async () => {
  const conn = await mysql.createConnection({host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME});
  const [rows] = await conn.query(\"SELECT twilio_account_sid, twilio_auth_token FROM organizations WHERE id = 5\");
  const { twilio_account_sid, twilio_auth_token } = rows[0];
  const client = twilio(twilio_account_sid, twilio_auth_token);
  const numbers = await client.incomingPhoneNumbers.list({phoneNumber: \"+1XXXXXXXXXX\"});
  const updated = await client.incomingPhoneNumbers(numbers[0].sid).update({
    voiceUrl: \"https://demo.twilio.com/welcome/voice/\",
    voiceMethod: \"POST\",
    smsUrl: \"https://demo.twilio.com/welcome/sms/reply\",
    smsMethod: \"POST\",
  });
  console.log(\"Revertido:\", updated.phoneNumber, updated.voiceUrl, updated.smsUrl);
})().catch(e => { console.error(\"ERROR:\", e.message); process.exit(1); });
"'
```

## Limitaciones conocidas

- **SMS al celular colombiano está bloqueado hoy** por Geographic Permissions de
  Twilio (cuenta completa, no por número) — error `21408`. Se arregla desde la
  consola de Twilio: *Messaging → Settings → Geo permissions → habilitar Colombia*.
  No hay forma de activarlo por API. La llamada de voz **sí funciona** sin este
  permiso.
- El texto/TwiML del reenvío es el mismo para cualquier número que se configure así
  — no hay forma de personalizarlo por número sin tocar código.

## Números usados con este procedimiento

| Número | Pool / organización | Estado (2026-09-24) |
|---|---|---|
| +13073572609 | Voxia, org 5 (Asiste Health Care) | Activo — reenvía a celular. Reservado también como número de WhatsApp Business de Vital (pendiente aprobación Meta); revisar cuando eso se apruebe |
| +19715217679 | Voxia, org 5 | Activo — reenvía a celular |
| +12202348566 | Voxia, org 5 | Activo — reenvía a celular |
| +16067157842 (ObamaCus1) | Proyecto aparte del compañero, misma cuenta Twilio | Revertido — tenía historial de llamadas salientes, Meta no mandó el código (posible marca de spam). No usar para esto |
