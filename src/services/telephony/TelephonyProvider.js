class NotSupportedError extends Error {
  constructor(providerName, method) {
    super(`El proveedor "${providerName}" no soporta la operacion "${method}".`);
    this.name = 'NotSupportedError';
  }
}

/**
 * Contrato que debe cumplir cualquier proveedor de telefonia (Twilio,
 * SIP nativo de OpenAI, o futuros proveedores). El resto de la aplicacion
 * (controllers, orquestador) solo depende de esta interfaz, nunca de un
 * SDK especifico. Ver providerFactory.js para el registro/activacion por
 * variable de entorno.
 */
class TelephonyProvider {
  get name() {
    throw new Error('Debe implementarse el getter "name" en el proveedor.');
  }

  /**
   * Origina una llamada saliente. Aplica a proveedores "activos" como
   * Twilio, donde Voxia posee/controla el numero. Un proveedor "pasivo"
   * (ej. SIP nativo, donde el trunk del call center origina la llamada)
   * debe lanzar NotSupportedError.
   */
  async initiateOutboundCall({ contact, campaign, callLog }) {
    throw new NotSupportedError(this.name, 'initiateOutboundCall');
  }

  /**
   * Extrae de un payload de webhook entrante los datos minimos para
   * localizar el contacto (numero de destino) y el id externo de la
   * llamada. Aplica a proveedores "pasivos" (SIP nativo).
   */
  parseIncomingCallPayload(rawBody) {
    throw new NotSupportedError(this.name, 'parseIncomingCallPayload');
  }

  /**
   * Normaliza un evento de estado propio del proveedor (status callback de
   * Twilio, evento de webhook de OpenAI, etc.) al set de estados internos
   * de call_logs: queued | ringing | in_progress | completed | failed |
   * no_answer | voicemail.
   */
  mapStatusEvent(rawEvent) {
    throw new NotSupportedError(this.name, 'mapStatusEvent');
  }
}

module.exports = { TelephonyProvider, NotSupportedError };
