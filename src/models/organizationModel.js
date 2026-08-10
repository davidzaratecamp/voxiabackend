const { pool } = require('../config/db');

async function create({ name, telephonyProvider }) {
  const [result] = await pool.query(
    'INSERT INTO organizations (name, telephony_provider) VALUES (:name, :telephonyProvider)',
    { name, telephonyProvider }
  );
  return findById(result.insertId);
}

async function findAll() {
  const [rows] = await pool.query(
    `SELECT o.*, COUNT(DISTINCT c.id) AS total_campaigns
     FROM organizations o
     LEFT JOIN campaigns c ON c.organization_id = o.id
     GROUP BY o.id
     ORDER BY o.created_at DESC`
  );
  return rows;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM organizations WHERE id = :id', { id });
  return rows[0] || null;
}

// Solo credenciales Twilio propias por ahora -- ver comentario de
// twilio_account_sid/twilio_auth_token en schema.sql. Pasar '' (string
// vacio) para cualquiera de los dos los limpia (vuelve a NULL, cae al
// .env global); pasar undefined deja el campo como esta.
async function update(id, { twilioAccountSid, twilioAuthToken }) {
  const fields = [];
  const params = { id };

  if (twilioAccountSid !== undefined) {
    fields.push('twilio_account_sid = :twilioAccountSid');
    params.twilioAccountSid = twilioAccountSid || null;
  }
  if (twilioAuthToken !== undefined) {
    fields.push('twilio_auth_token = :twilioAuthToken');
    params.twilioAuthToken = twilioAuthToken || null;
  }

  if (fields.length === 0) return findById(id);

  await pool.query(`UPDATE organizations SET ${fields.join(', ')} WHERE id = :id`, params);
  return findById(id);
}

module.exports = { create, findAll, findById, update };
