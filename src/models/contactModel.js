const { pool } = require('../config/db');

async function bulkInsert(campaignId, contacts) {
  if (!contacts.length) return { inserted: 0 };

  const values = contacts.map((c) => [
    campaignId,
    c.phone_number,
    c.full_name || null,
    c.balance_due ?? null,
    c.extra_data ? JSON.stringify(c.extra_data) : null,
  ]);

  const [result] = await pool.query(
    `INSERT INTO contacts (campaign_id, phone_number, full_name, balance_due, extra_data)
     VALUES ?`,
    [values]
  );

  return { inserted: result.affectedRows };
}

async function findByCampaign(campaignId, { status } = {}) {
  const params = { campaignId };
  let query = 'SELECT * FROM contacts WHERE campaign_id = :campaignId';
  if (status) {
    query += ' AND call_status = :status';
    params.status = status;
  }
  query += ' ORDER BY created_at DESC';
  const [rows] = await pool.query(query, params);
  return rows;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM contacts WHERE id = :id', { id });
  return rows[0] || null;
}

async function findPendingByCampaign(campaignId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT * FROM contacts
     WHERE campaign_id = :campaignId AND call_status = 'pending'
     ORDER BY created_at ASC
     LIMIT :limit`,
    { campaignId, limit }
  );
  return rows;
}

async function findByPhoneAndCampaign(phoneNumber, campaignId) {
  const [rows] = await pool.query(
    'SELECT * FROM contacts WHERE phone_number = :phoneNumber AND campaign_id = :campaignId ORDER BY created_at DESC LIMIT 1',
    { phoneNumber, campaignId }
  );
  return rows[0] || null;
}

// Usado por el webhook de SIP nativo: el numero de destino por si solo no
// alcanza para resolver el contacto en un sistema multi-tenant (dos
// organizaciones pueden tener un contacto con el mismo telefono), por eso
// siempre se filtra tambien por la organizacion del webhook que llego.
async function findLatestByPhoneAndOrganization(phoneNumber, organizationId) {
  const [rows] = await pool.query(
    `SELECT ct.* FROM contacts ct
     JOIN campaigns c ON c.id = ct.campaign_id
     WHERE ct.phone_number = :phoneNumber AND c.organization_id = :organizationId
     ORDER BY ct.created_at DESC
     LIMIT 1`,
    { phoneNumber, organizationId }
  );
  return rows[0] || null;
}

async function updateStatus(id, callStatus, { incrementAttempts = false } = {}) {
  const query = incrementAttempts
    ? 'UPDATE contacts SET call_status = :callStatus, attempts = attempts + 1 WHERE id = :id'
    : 'UPDATE contacts SET call_status = :callStatus WHERE id = :id';
  await pool.query(query, { id, callStatus });
  return findById(id);
}

module.exports = {
  bulkInsert,
  findByCampaign,
  findById,
  findPendingByCampaign,
  findByPhoneAndCampaign,
  findLatestByPhoneAndOrganization,
  updateStatus,
};
