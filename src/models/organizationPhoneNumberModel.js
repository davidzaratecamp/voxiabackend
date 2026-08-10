const { pool } = require('../config/db');

async function listByOrganization(organizationId) {
  const [rows] = await pool.query(
    'SELECT * FROM organization_phone_numbers WHERE organization_id = :organizationId ORDER BY created_at ASC',
    { organizationId }
  );
  return rows;
}

// INSERT IGNORE: pegar la misma lista dos veces (ej. el usuario reenvia el
// mismo texto por error) no falla, solo ignora los duplicados gracias al
// UNIQUE (organization_id, phone_number) del schema.
async function bulkCreate(organizationId, numbers) {
  if (numbers.length === 0) return [];

  const values = numbers.map((phoneNumber) => [organizationId, phoneNumber]);
  await pool.query('INSERT IGNORE INTO organization_phone_numbers (organization_id, phone_number) VALUES ?', [
    values,
  ]);
  return listByOrganization(organizationId);
}

// organizationId en el WHERE a proposito: evita que alguien manipule el id
// de un numero de otra organizacion adivinando el id.
async function setActive(id, organizationId, isActive) {
  await pool.query(
    'UPDATE organization_phone_numbers SET is_active = :isActive WHERE id = :id AND organization_id = :organizationId',
    { id, organizationId, isActive }
  );
}

async function remove(id, organizationId) {
  await pool.query('DELETE FROM organization_phone_numbers WHERE id = :id AND organization_id = :organizationId', {
    id,
    organizationId,
  });
}

// Rotacion round-robin: toma el numero activo con el use_count mas bajo
// (desempatado por id) y lo incrementa. Usa un contador, no last_used_at,
// porque TIMESTAMP solo tiene resolucion de 1 segundo -- con llamadas
// saliendo mas rapido que eso, varios claims empatarian en el mismo
// segundo y el desempate por id repetiria siempre el mismo numero en vez
// de rotar parejo. SELECT ... FOR UPDATE dentro de una transaccion evita
// que dos llamadas casi simultaneas reclamen el mismo numero. Devuelve
// null si la organizacion no tiene ningun numero activo -- el llamador cae
// al numero global del .env en ese caso (ver twilioRealtimeProvider.js).
async function claimNextNumber(organizationId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, phone_number FROM organization_phone_numbers
       WHERE organization_id = :organizationId AND is_active = 1
       ORDER BY use_count ASC, id ASC
       LIMIT 1
       FOR UPDATE`,
      { organizationId }
    );

    if (rows.length === 0) {
      await conn.rollback();
      return null;
    }

    const chosen = rows[0];
    await conn.query(
      'UPDATE organization_phone_numbers SET use_count = use_count + 1, last_used_at = NOW() WHERE id = :id',
      { id: chosen.id }
    );
    await conn.commit();
    return chosen.phone_number;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listByOrganization, bulkCreate, setActive, remove, claimNextNumber };
