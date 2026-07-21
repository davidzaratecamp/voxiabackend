const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { bootstrapPool, schemaPool, pool } = require('../config/db');

async function ensureDatabaseExists() {
  const conn = await bootstrapPool.getConnection();
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`[db:init] Base de datos "${env.db.database}" verificada/creada.`);
  } finally {
    conn.release();
  }
}

async function runSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = await schemaPool.getConnection();
  try {
    for (const statement of statements) {
      await conn.query(statement);
    }
    console.log(`[db:init] ${statements.length} sentencias de schema ejecutadas correctamente.`);
  } finally {
    conn.release();
  }
}

// Idempotente: crea el primer usuario admin solo si no existe ya un usuario
// con ese email. Usa `pool` (namedPlaceholders habilitado) -- `schemaPool`
// deliberadamente no lo tiene (ver config/db.js), asi que un INSERT
// parametrizado ahi fallaria.
async function seedAdmin() {
  if (!env.seedAdmin.email || !env.seedAdmin.password) {
    console.log('[db:init] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD no configurados, se omite el seed.');
    return;
  }

  const [rows] = await pool.query('SELECT id FROM users WHERE email = :email', { email: env.seedAdmin.email });
  if (rows.length > 0) {
    console.log(`[db:init] El usuario admin "${env.seedAdmin.email}" ya existe, se omite el seed.`);
    return;
  }

  const passwordHash = await bcrypt.hash(env.seedAdmin.password, 10);
  await pool.query(
    `INSERT INTO users (organization_id, email, password_hash, full_name, role)
     VALUES (NULL, :email, :passwordHash, 'Admin', 'admin')`,
    { email: env.seedAdmin.email, passwordHash }
  );
  console.log(`[db:init] Usuario admin "${env.seedAdmin.email}" creado.`);
}

async function initDatabase() {
  await ensureDatabaseExists();
  await runSchema();
  await seedAdmin();
}

// Permite ejecutar `npm run db:init` de forma standalone, y tambien
// reutilizar la funcion desde server.js al arrancar la app.
if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('[db:init] Listo.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[db:init] Error inicializando la base de datos:', err);
      process.exit(1);
    });
}

module.exports = { initDatabase };
