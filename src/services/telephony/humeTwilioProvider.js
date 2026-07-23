const TwilioRealtimeProvider = require('./twilioRealtimeProvider');

/**
 * Proveedor de PRUEBA: origina la llamada exactamente igual que
 * twilioRealtimeProvider y elevenLabsTwilioProvider (misma cuenta de
 * Twilio, mismo webhook de voz propio -- a diferencia de la integracion
 * "nativa" que ofrece Hume, aqui Twilio sigue conectando su Media Stream a
 * NUESTRO WebSocket, no al de Hume, para poder inyectar dynamic_variables
 * por contacto). El puente de audio en twilioMediaStreamHandler.js conecta
 * a Hume EVI (con transcodificacion mu-law<->PCM16, ver audioCodec.js)
 * cuando una campana usa este proveedor.
 */
class HumeTwilioProvider extends TwilioRealtimeProvider {
  get name() {
    return 'hume_evi_twilio';
  }
}

module.exports = HumeTwilioProvider;
