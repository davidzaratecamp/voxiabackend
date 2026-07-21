const mysql = require('mysql2/promise');
const env = require('./env');

// Pool sin `database` seleccionada: init.js la crea si no existe antes de
// que el resto de la app abra conexiones contra ella.
const bootstrapPool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  waitForConnections: true,
  connectionLimit: 5,
});

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

// Pool sin namedPlaceholders, usado solo para ejecutar schema.sql: ese
// archivo trae comentarios con ":" (ej. "npm run db:init") que la libreria
// de named-placeholders interpreta erroneamente como parametros.
const schemaPool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 2,
});

module.exports = { pool, bootstrapPool, schemaPool };
