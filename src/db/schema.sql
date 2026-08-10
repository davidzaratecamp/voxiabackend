-- Voxia - Schema inicial (MVP)
-- Se ejecuta automaticamente via `npm run db:init` (ver src/db/init.js)
-- init.js corre estas sentencias en el orden en que aparecen en este archivo,
-- por eso organizations/users van antes que cualquier tabla que las referencie.

CREATE TABLE IF NOT EXISTS organizations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,

  -- Proveedor de telefonia fijo de este cliente, asignado por el admin al
  -- darlo de alta. Debe estar dentro del set habilitado por
  -- TELEPHONY_PROVIDERS en .env (ver providerFactory.js).
  telephony_provider ENUM('twilio_realtime', 'openai_native_sip') NOT NULL,

  -- Credenciales Twilio propias de este cliente (si trae su propia cuenta).
  -- NULL en cualquiera de las dos = usar las credenciales globales del .env
  -- del backend (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) -- ver
  -- twilioRealtimeProvider.js. Asi organizaciones sin cuenta propia siguen
  -- funcionando exactamente igual que antes de que existieran estos campos.
  twilio_account_sid VARCHAR(64) DEFAULT NULL,
  twilio_auth_token VARCHAR(64) DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pool de numeros propios de una organizacion con cuenta Twilio propia (ver
-- twilio_account_sid arriba). Cada llamada saliente rota entre los numeros
-- activos (el que lleva mas tiempo sin usarse sale primero, ver
-- organizationPhoneNumberModel.claimNextNumber) para no concentrar todo el
-- volumen de una campana en un solo numero y que los operadores lo marquen
-- como spam. Una organizacion sin filas aqui simplemente usa el numero
-- global del .env (TWILIO_FROM_NUMBER), sin cambio de comportamiento.
CREATE TABLE IF NOT EXISTS organization_phone_numbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,

  -- Manda la rotacion (ORDER BY use_count ASC, id ASC en claimNextNumber),
  -- no last_used_at: TIMESTAMP solo tiene resolucion de 1 segundo, y con
  -- llamadas saliendo mas rapido que eso (caso real: 600 contactos) varios
  -- claims empatarian en el mismo segundo y el desempate por id repetiria
  -- siempre el numero de id mas bajo en vez de rotar parejo.
  use_count INT NOT NULL DEFAULT 0,
  -- Solo informativo (se muestra en la interfaz), no se usa para ordenar.
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_org_phone_numbers_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE KEY uq_org_phone_number (organization_id, phone_number),
  INDEX idx_org_phone_numbers_organization (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- NULL = usuario admin (Voxia/vendedor), ve todas las organizaciones.
  organization_id INT DEFAULT NULL,

  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  full_name VARCHAR(150) DEFAULT NULL,
  role ENUM('admin', 'client') NOT NULL DEFAULT 'client',

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_users_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS campaigns (
  id INT AUTO_INCREMENT PRIMARY KEY,

  organization_id INT NOT NULL,

  name VARCHAR(150) NOT NULL,
  type ENUM('cobranza', 'ventas', 'encuesta', 'recordatorio', 'otro') NOT NULL DEFAULT 'otro',

  -- Espejo de organizations.telephony_provider. UNICO write-path: se copia
  -- server-side en campaignController.create al momento de crear la
  -- campana (ver comentario en ese archivo) -- nunca lo escribas desde
  -- otro lugar o se puede desincronizar del proveedor real del cliente.
  telephony_provider ENUM('twilio_realtime', 'openai_native_sip') NOT NULL,

  voice VARCHAR(50) NOT NULL DEFAULT 'alloy',

  -- Idioma en el que el agente conversa esta campana. Determina tanto el
  -- bloque de estilo de conversacion (DELIVERY_STYLE_INSTRUCTIONS_* en
  -- promptBuilder.js) como el formato de moneda de {{balance_due}}.
  language ENUM('es', 'en') NOT NULL DEFAULT 'es',

  -- Acento/region especifico dentro del idioma (ej. 'es_CO', 'es_PR',
  -- 'en_US'). Determina el bloque de estilo exacto en promptBuilder.js
  -- (ACCENT_STYLE_BY_CODE) -- language sigue mandando el idioma base
  -- (moneda, instruccion de "siempre habla en X"), accent afina el sabor
  -- regional dentro de ese idioma.
  accent VARCHAR(10) NOT NULL DEFAULT 'es_CO',

  -- Velocidad de habla del agente para la API Realtime (0.25 a 1.5, 1.0 =
  -- normal). Ver audio.output.speed en promptBuilder.js.
  speed DECIMAL(3, 2) NOT NULL DEFAULT 1.00,

  -- Cuanto puede extenderse el agente por turno de habla. Ver
  -- TURN_LENGTH_LINE_BY_LANGUAGE en promptBuilder.js. Default 'short'
  -- reproduce el comportamiento fijo que tenia el sistema antes de este
  -- campo (maximo 2-3 frases por turno).
  turn_length ENUM('short', 'normal', 'long') NOT NULL DEFAULT 'short',

  -- Si el agente puede enumerar pasos/puntos hablados o no. Ver
  -- LISTS_LINE_BY_LANGUAGE en promptBuilder.js. Default 0 reproduce el
  -- comportamiento fijo anterior (nunca hacer listas).
  allow_lists TINYINT(1) NOT NULL DEFAULT 0,

  -- Plantilla de instrucciones del agente. Soporta placeholders {{full_name}},
  -- {{balance_due}}, {{phone_number}} resueltos por promptBuilder.js
  system_prompt_template TEXT NOT NULL,

  status ENUM('draft', 'active', 'paused', 'completed') NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_campaigns_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  INDEX idx_campaigns_organization (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  full_name VARCHAR(150) DEFAULT NULL,
  balance_due DECIMAL(12, 2) DEFAULT NULL,

  -- Campos libres especificos de la campana (ej. fecha_limite, producto, etc.)
  extra_data JSON DEFAULT NULL,

  call_status ENUM('pending', 'calling', 'in_progress', 'completed', 'voicemail', 'failed', 'no_answer')
    NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_contacts_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  INDEX idx_contacts_campaign_status (campaign_id, call_status),
  INDEX idx_contacts_phone (phone_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_id INT NOT NULL,
  campaign_id INT NOT NULL,

  telephony_provider ENUM('twilio_realtime', 'openai_native_sip') NOT NULL,

  -- Call SID de Twilio o call_id de OpenAI, segun el proveedor
  external_call_id VARCHAR(120) DEFAULT NULL,

  -- Numero de origen que hizo esta llamada -- solo se llena para
  -- twilio_realtime con pool propio (ver organization_phone_numbers). Sirve
  -- para revisar despues si algun numero especifico empieza a fallar/ser
  -- marcado como spam por los operadores.
  from_number VARCHAR(20) DEFAULT NULL,

  status ENUM('queued', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'voicemail')
    NOT NULL DEFAULT 'queued',

  outcome ENUM('promise_to_pay', 'refused', 'callback_requested', 'not_interested', 'sale_confirmed', 'no_outcome')
    NOT NULL DEFAULT 'no_outcome',

  started_at DATETIME DEFAULT NULL,
  ended_at DATETIME DEFAULT NULL,
  duration_seconds INT NOT NULL DEFAULT 0,

  -- Costo estimado en tokens de la API Realtime de OpenAI para esta llamada
  estimated_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd DECIMAL(10, 4) NOT NULL DEFAULT 0,

  transcript LONGTEXT DEFAULT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_call_logs_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_call_logs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  INDEX idx_call_logs_campaign (campaign_id),
  INDEX idx_call_logs_status (status),
  INDEX idx_call_logs_external_id (external_call_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
