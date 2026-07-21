const { TelephonyProvider } = require('./TelephonyProvider');

const SIP_STATUS_MAP = {
  ringing: 'ringing',
  active: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  no_answer: 'no_answer',
};

/**
 * Proveedor "pasivo": el call center conecta su propio trunk SIP (Movistar,
 * Claro, etc.) directamente a OpenAI. OpenAI origina la sesion y notifica a
 * Voxia via webhook (POST /api/v1/webhooks/openai/incoming?organizationId=X)
 * para pedir la configuracion de la sesion. Voxia nunca origina la llamada
 * aqui. La URL exacta (con el organizationId del cliente) se muestra en el
 * panel de administracion al crear una organizacion con este proveedor.
 *
 * IMPORTANTE: el nombre exacto de los campos del payload (to/from/call_id)
 * corresponde al contrato descrito para el MVP. Verificar contra la
 * documentacion vigente de "SIP nativo" de OpenAI antes de salir a
 * produccion, ya que es una superficie de API en evolucion.
 */
class OpenAISipProvider extends TelephonyProvider {
  get name() {
    return 'openai_native_sip';
  }

  parseIncomingCallPayload(rawBody) {
    const toPhoneNumber = rawBody.to || rawBody.to_number || rawBody?.sip?.to;
    const externalCallId = rawBody.call_id || rawBody.id;

    if (!toPhoneNumber || !externalCallId) {
      throw new Error('Payload de webhook SIP incompleto: se esperaba "to" y "call_id".');
    }

    return { toPhoneNumber, externalCallId, raw: rawBody };
  }

  mapStatusEvent(rawEvent) {
    const status = SIP_STATUS_MAP[rawEvent.status] || 'failed';
    return { status };
  }
}

module.exports = OpenAISipProvider;
