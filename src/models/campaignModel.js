const { pool } = require('../config/db');

// telephonyProvider siempre viene forzado desde organizations.telephony_provider
// (ver campaignController.create) -- este modelo solo persiste lo que le pasan.
async function create({ organizationId, name, type, telephonyProvider, voice, language, accent, speed, systemPromptTemplate }) {
  const [result] = await pool.query(
    `INSERT INTO campaigns (organization_id, name, type, telephony_provider, voice, language, accent, speed, system_prompt_template)
     VALUES (:organizationId, :name, :type, :telephonyProvider, :voice, :language, :accent, :speed, :systemPromptTemplate)`,
    { organizationId, name, type, telephonyProvider, voice, language, accent, speed, systemPromptTemplate }
  );
  return findById(result.insertId);
}

async function findAll(organizationId) {
  const params = {};
  let where = '';
  if (organizationId) {
    where = 'WHERE c.organization_id = :organizationId';
    params.organizationId = organizationId;
  }

  const [rows] = await pool.query(
    `SELECT c.*,
            COUNT(DISTINCT ct.id) AS total_contacts,
            SUM(CASE WHEN ct.call_status = 'completed' THEN 1 ELSE 0 END) AS completed_contacts
     FROM campaigns c
     LEFT JOIN contacts ct ON ct.campaign_id = c.id
     ${where}
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    params
  );
  return rows;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM campaigns WHERE id = :id', { id });
  return rows[0] || null;
}

async function updateStatus(id, status) {
  await pool.query('UPDATE campaigns SET status = :status WHERE id = :id', { id, status });
  return findById(id);
}

// telephonyProvider y organizationId NO son editables aqui a proposito
// (siguen atados a la organizacion, ver campaignController.create).
async function update(id, { name, type, voice, language, accent, speed, systemPromptTemplate }) {
  const fields = [];
  const params = { id };

  if (name !== undefined) {
    fields.push('name = :name');
    params.name = name;
  }
  if (type !== undefined) {
    fields.push('type = :type');
    params.type = type;
  }
  if (voice !== undefined) {
    fields.push('voice = :voice');
    params.voice = voice;
  }
  if (language !== undefined) {
    fields.push('language = :language');
    params.language = language;
  }
  if (accent !== undefined) {
    fields.push('accent = :accent');
    params.accent = accent;
  }
  if (speed !== undefined) {
    fields.push('speed = :speed');
    params.speed = speed;
  }
  if (systemPromptTemplate !== undefined) {
    fields.push('system_prompt_template = :systemPromptTemplate');
    params.systemPromptTemplate = systemPromptTemplate;
  }

  if (fields.length === 0) return findById(id);

  await pool.query(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = :id`, params);
  return findById(id);
}

// contacts y call_logs tienen ON DELETE CASCADE hacia campaigns (ver
// schema.sql) -- borrar la campana se lleva tambien todo su historial.
async function remove(id) {
  await pool.query('DELETE FROM campaigns WHERE id = :id', { id });
}

module.exports = { create, findAll, findById, updateStatus, update, remove };
