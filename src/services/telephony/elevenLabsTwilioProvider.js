const TwilioRealtimeProvider = require('./twilioRealtimeProvider');

/**
 * Proveedor de PRUEBA: origina la llamada exactamente igual que
 * twilioRealtimeProvider (misma cuenta de Twilio, mismo webhook de voz) --
 * la unica diferencia es que el puente de audio en
 * src/ws/twilioMediaStreamHandler.js conecta a ElevenLabs Conversational AI
 * en vez de a OpenAI Realtime cuando una campana usa este proveedor. Se
 * reutiliza el 100% de la logica de origen de llamada de Twilio (no tiene
 * nada especifico de OpenAI) via herencia, solo cambia el nombre con el que
 * se registra/identifica el proveedor.
 */
class ElevenLabsTwilioProvider extends TwilioRealtimeProvider {
  get name() {
    return 'elevenlabs_twilio';
  }
}

module.exports = ElevenLabsTwilioProvider;
