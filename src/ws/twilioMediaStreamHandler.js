const WebSocket = require('ws');
const env = require('../config/env');
const contactModel = require('../models/contactModel');
const campaignModel = require('../models/campaignModel');
const callLogModel = require('../models/callLogModel');
const callOrchestrator = require('../services/callOrchestrator');
const promptBuilder = require('../services/promptBuilder');

/**
 * Puente de audio bidireccional Twilio Media Streams <-> OpenAI Realtime.
 * Twilio envia/espera audio mulaw 8kHz, que se declara en promptBuilder.js
 * como audio/pcmu (formato G.711 mu-law de la API Realtime GA), asi que no
 * se requiere transcodificacion manual en el MVP.
 *
 * Shape y nombres de evento verificados en 2026-07 contra trafico real de
 * la API GA (no la beta vieja, que usaba otros nombres): el audio de salida
 * y su transcripcion llegan como "response.output_audio.delta" y
 * "response.output_audio_transcript.delta" -- OJO si la API cambia de nuevo.
 *
 * Cada delta de audio se reenvia a Twilio tal cual llega, sin recortarlo a
 * un tamano fijo ni re-espaciarlo con un timer propio -- se probo una version
 * con recorte manual a frames de 20ms y sono peor (entrecortado, "walkie
 * talkie") que este relay directo. El propio ritmo de entrega de OpenAI
 * resulto mas confiable que reconstruirlo a mano.
 */
function registerTwilioMediaStreamHandler(wss) {
  wss.on('connection', (twilioSocket) => {
    console.log('[twilio-stream] Conexion WS entrante.');
    let openaiSocket = null;
    let streamSid = null;
    let callLogId = null;
    let transcriptBuffer = '';
    let callStartedAt = null;
    let mediaFromTwilioCount = 0;

    twilioSocket.on('message', async (raw) => {
      const event = JSON.parse(raw.toString());

      switch (event.event) {
        case 'start': {
          streamSid = event.start.streamSid;
          const params = event.start.customParameters || {};
          callLogId = params.callLogId;
          callStartedAt = Date.now();
          console.log(`[twilio-stream] start callLogId=${callLogId} contactId=${params.contactId}`);

          // Verifica que esta conexion corresponda a una llamada real que
          // Voxia origino y que sigue en un estado que espera audio --
          // evita que alguien que descubra la URL del stream abra sesiones
          // Realtime arbitrarias (costo en la cuenta de OpenAI + posible
          // fuga del system_prompt_template de un cliente).
          // Incluye 'in_progress': el status callback de Twilio ("answered")
          // suele llegar casi al mismo tiempo que el evento 'start' del
          // stream y puede adelantarsele, marcando la llamada in_progress
          // antes de que el audio empiece a fluir.
          const callLog = await callLogModel.findById(callLogId);
          if (!callLog || !['queued', 'ringing', 'in_progress'].includes(callLog.status)) {
            console.warn(`[twilio-stream] callLogId=${callLogId} en estado invalido (${callLog?.status}), cerrando socket.`);
            twilioSocket.close();
            return;
          }

          const contact = await contactModel.findById(params.contactId);
          const campaign = await campaignModel.findById(contact.campaign_id);
          const sessionConfig = promptBuilder.buildSessionConfig({ campaign, contact });
          console.log(`[twilio-stream] Conectando a OpenAI Realtime (modelo ${sessionConfig.model})...`);

          openaiSocket = connectToOpenAIRealtime(sessionConfig, {
            onAudioDelta: (base64Audio) => {
              if (twilioSocket.readyState === WebSocket.OPEN) {
                twilioSocket.send(
                  JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: base64Audio },
                  })
                );
              }
            },
            onTranscriptDelta: (text) => {
              transcriptBuffer += text;
            },
            // El interlocutor empezo a hablar mientras el agente hablaba.
            // OpenAI deja de generar audio nuevo por su cuenta
            // (interrupt_response), pero el audio que ya le mandamos a
            // Twilio sigue en su buffer de reproduccion -- sin este "clear"
            // el agente seguiria sonando varios segundos despues de que
            // deberia haberse callado.
            onInterrupt: () => {
              if (twilioSocket.readyState === WebSocket.OPEN) {
                twilioSocket.send(JSON.stringify({ event: 'clear', streamSid }));
              }
            },
          });
          break;
        }

        case 'media': {
          mediaFromTwilioCount += 1;
          if (mediaFromTwilioCount === 1 || mediaFromTwilioCount % 100 === 0) {
            console.log(
              `[twilio-stream] media #${mediaFromTwilioCount} de Twilio (openaiSocket ${openaiSocket ? openaiSocket.readyState : 'null'})`
            );
          }
          if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
            openaiSocket.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: event.media.payload,
              })
            );
          }
          break;
        }

        case 'stop': {
          console.log(`[twilio-stream] stop callLogId=${callLogId}`);
          if (openaiSocket) openaiSocket.close();

          if (callLogId) {
            const durationSeconds = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0;
            await callOrchestrator.completeCall(callLogId, {
              transcript: transcriptBuffer,
              durationSeconds,
            });
          }
          break;
        }

        default:
          break;
      }
    });

    twilioSocket.on('close', () => {
      if (openaiSocket) openaiSocket.close();
    });
  });
}

// Justo al conectar la llamada hay ruido/eco de linea (tono de timbrado
// que se alcanza a colar, la propia voz del agente rebotando en el
// telefono de quien contesta antes de que se estabilice la linea) que el
// VAD de OpenAI a veces confunde con que el interlocutor empezo a hablar
// -- eso corta el saludo del agente a mitad de palabra, varias veces
// seguidas, justo al inicio de la llamada. Ignorar interrupciones durante
// este colchon inicial evita el problema sin afectar la interrupcion real
// una vez la conversacion ya esta en curso.
const INTERRUPT_GRACE_PERIOD_MS = 1200;

function connectToOpenAIRealtime(sessionConfig, { onAudioDelta, onTranscriptDelta, onInterrupt }) {
  // "model" solo va en la URL de conexion -- el resto de sessionConfig
  // (voice/instructions/modalities/turn_detection/tools) es el payload de
  // session.update.
  const { model, ...session } = sessionConfig;
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const socket = new WebSocket(url, {
    headers: {
      // Sin header "OpenAI-Beta": la API Realtime ya es GA y ese header
      // fuerza el shape viejo de la beta, que OpenAI dejo de soportar.
      Authorization: `Bearer ${env.openai.apiKey}`,
    },
  });

  let connectedAt = null;

  // Instrumentacion de latencia: mide desde que se dispara un turno (el
  // "response.create" inicial, o el momento en que el usuario deja de
  // hablar) hasta que llega el primer byte de audio de respuesta. Esto es
  // lo que se siente como "tarda en contestar" -- con esto hay datos reales
  // en vez de adivinar si el cuello de botella es el modelo, la red, o el
  // tunel de ngrok.
  let turnStartedAt = null;

  socket.on('open', () => {
    console.log('[openai-realtime] Socket abierto, enviando session.update.');
    connectedAt = Date.now();
    socket.send(JSON.stringify({ type: 'session.update', session }));

    // En una llamada saliente el que contesta esta en silencio esperando
    // escuchar algo -- con server_vad el modelo solo responde a audio del
    // usuario, asi que sin este disparo el agente nunca hablaria primero.
    turnStartedAt = Date.now();
    socket.send(JSON.stringify({ type: 'response.create' }));
  });

  let audioDeltaCount = 0;
  let firstDeltaOfTurn = true;
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());

    // Nombres de evento confirmados contra trafico real de la API GA (no
    // coinciden con el naming de la beta que documentaba "response.audio.delta"):
    // el audio y su transcripcion van bajo "output_audio".
    if (event.type === 'response.output_audio.delta' && event.delta) {
      audioDeltaCount += 1;
      if (firstDeltaOfTurn && turnStartedAt) {
        console.log(`[openai-realtime] latencia hasta primer audio: ${Date.now() - turnStartedAt}ms`);
        firstDeltaOfTurn = false;
      }
      if (audioDeltaCount === 1 || audioDeltaCount % 50 === 0) {
        console.log(`[openai-realtime] audio delta #${audioDeltaCount}`);
      }
      onAudioDelta(event.delta);
    }
    if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
      onTranscriptDelta(event.delta);
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      const sinceConnected = connectedAt ? Date.now() - connectedAt : Infinity;
      if (sinceConnected < INTERRUPT_GRACE_PERIOD_MS) {
        console.log(`[openai-realtime] interrupcion ignorada (colchon inicial, ${sinceConnected}ms desde conectar)`);
      } else {
        onInterrupt();
      }
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      turnStartedAt = Date.now();
      firstDeltaOfTurn = true;
    }
    if (event.type === 'error') {
      console.error('[openai-realtime] Evento de error:', JSON.stringify(event));
    }
  });

  socket.on('close', (code, reason) => {
    console.log(`[openai-realtime] Socket cerrado. code=${code} reason=${reason?.toString()}`);
  });

  socket.on('error', (err) => {
    console.error('[openai-realtime] Error de socket:', err.message);
  });

  return socket;
}

module.exports = { registerTwilioMediaStreamHandler };
