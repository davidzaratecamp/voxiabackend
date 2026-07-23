const WebSocket = require('ws');
const env = require('../config/env');
const contactModel = require('../models/contactModel');
const campaignModel = require('../models/campaignModel');
const callLogModel = require('../models/callLogModel');
const callOrchestrator = require('../services/callOrchestrator');
const promptBuilder = require('../services/promptBuilder');
const audioCodec = require('../services/telephony/audioCodec');

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
    let realtimeSocket = null;
    let activeProvider = null;
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
          activeProvider = campaign.telephony_provider;

          const callbacks = {
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
            // Ambos backends dejan de generar audio nuevo por su cuenta,
            // pero el audio que ya le mandamos a Twilio sigue en su buffer
            // de reproduccion -- sin este "clear" el agente seguiria
            // sonando varios segundos despues de que deberia haberse
            // callado.
            onInterrupt: () => {
              if (twilioSocket.readyState === WebSocket.OPEN) {
                twilioSocket.send(JSON.stringify({ event: 'clear', streamSid }));
              }
            },
          };

          try {
            if (activeProvider === 'elevenlabs_twilio') {
              console.log('[twilio-stream] Conectando a ElevenLabs Conversational AI...');
              realtimeSocket = await connectToElevenLabsRealtime(contact, callbacks);
            } else if (activeProvider === 'hume_evi_twilio') {
              console.log('[twilio-stream] Conectando a Hume EVI...');
              realtimeSocket = await connectToHumeRealtime(contact, callbacks);
            } else {
              const sessionConfig = promptBuilder.buildSessionConfig({ campaign, contact });
              console.log(`[twilio-stream] Conectando a OpenAI Realtime (modelo ${sessionConfig.model})...`);
              realtimeSocket = connectToOpenAIRealtime(sessionConfig, callbacks);
            }
          } catch (err) {
            console.error(`[twilio-stream] Error conectando al backend de voz (${activeProvider}):`, err.message);
            twilioSocket.close();
            return;
          }
          break;
        }

        case 'media': {
          mediaFromTwilioCount += 1;
          if (mediaFromTwilioCount === 1 || mediaFromTwilioCount % 100 === 0) {
            console.log(
              `[twilio-stream] media #${mediaFromTwilioCount} de Twilio (realtimeSocket ${realtimeSocket ? realtimeSocket.readyState : 'null'})`
            );
          }
          if (realtimeSocket && realtimeSocket.readyState === WebSocket.OPEN) {
            // Cada backend espera su propio shape de mensaje (y a veces su
            // propio formato de audio) para el audio entrante -- ver
            // connectToOpenAIRealtime/connectToElevenLabsRealtime/connectToHumeRealtime.
            let payload;
            if (activeProvider === 'elevenlabs_twilio') {
              payload = JSON.stringify({ user_audio_chunk: event.media.payload });
            } else if (activeProvider === 'hume_evi_twilio') {
              // Unico de los 3 proveedores que no acepta mu-law -- se
              // transcodifica a PCM16 antes de mandarlo (ver audioCodec.js).
              const pcm16Base64 = audioCodec.twilioMuLawToHumePcm16Base64(event.media.payload);
              payload = JSON.stringify({ type: 'audio_input', data: pcm16Base64 });
            } else {
              payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: event.media.payload });
            }
            realtimeSocket.send(payload);
          }
          break;
        }

        case 'stop': {
          console.log(`[twilio-stream] stop callLogId=${callLogId}`);
          if (realtimeSocket) realtimeSocket.close();

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
      if (realtimeSocket) realtimeSocket.close();
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

// Pide una signed URL de un solo uso para conectar al agente -- asi la API
// key de ElevenLabs nunca viaja en la URL del WebSocket. Ver
// GET /v1/convai/conversation/get_signed_url en la documentacion de
// ElevenLabs Conversational AI.
async function fetchElevenLabsSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(
    env.elevenlabs.agentId
  )}`;
  const response = await fetch(url, { headers: { 'xi-api-key': env.elevenlabs.apiKey } });
  if (!response.ok) {
    throw new Error(`ElevenLabs get_signed_url fallo (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  return data.signed_url;
}

/**
 * Puente hacia ElevenLabs Conversational AI -- alterno de PRUEBA a
 * connectToOpenAIRealtime. Mismo formato de audio (ulaw_8000) que Twilio,
 * asi que no requiere transcodificacion, pero eso hay que configurarlo del
 * lado del agente en el dashboard de ElevenLabs (formato de entrada/salida
 * de audio = mu-law 8kHz) -- Voxia no lo controla desde aqui.
 *
 * La personalidad/guion del agente vive configurada en ElevenLabs
 * (agent_id), no en campaign.system_prompt_template -- aqui solo se pasan
 * dynamic_variables para que el prompt del agente pueda interpolar
 * {{full_name}}/{{phone_number}}/{{balance_due}} si los usa. A diferencia
 * de OpenAI, esta integracion NO reescribe el prompt completo desde Voxia.
 *
 * Superficie verificada contra la documentacion de ElevenLabs en 2026-07 --
 * como toda API de terceros en evolucion, revisar shape de mensajes si algo
 * deja de funcionar (mismo espiritu que la nota sobre el webhook SIP nativo
 * de OpenAI en openaiSipProvider.js).
 */
async function connectToElevenLabsRealtime(contact, { onAudioDelta, onTranscriptDelta, onInterrupt }) {
  if (!env.elevenlabs.apiKey || !env.elevenlabs.agentId) {
    throw new Error('Credenciales de ElevenLabs no configuradas (ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID).');
  }

  const signedUrl = await fetchElevenLabsSignedUrl();
  const socket = new WebSocket(signedUrl);

  socket.on('open', () => {
    console.log('[elevenlabs-realtime] Socket abierto, enviando conversation_initiation_client_data.');
    socket.send(
      JSON.stringify({
        type: 'conversation_initiation_client_data',
        dynamic_variables: {
          full_name: contact.full_name || '',
          phone_number: contact.phone_number,
          balance_due: contact.balance_due ?? '',
        },
      })
    );
  });

  // Misma instrumentacion de latencia que connectToOpenAIRealtime, para
  // poder comparar numeros reales entre los dos proveedores en vez de
  // adivinar. OJO con la comparacion: ElevenLabs no expone un evento de
  // "el usuario dejo de hablar" por separado del transcript -- aqui el
  // reloj arranca cuando llega user_transcript (transcripcion YA lista),
  // mientras que en OpenAI arranca en speech_stopped (antes de transcribir
  // nada). Eso hace que el numero medido aqui salga un poco MEJOR (mas
  // corto) de lo que seria una comparacion 100% equivalente -- el tiempo
  // real de "silencio a audio" en ElevenLabs es ese numero mas lo que tarde
  // su propio STT en transcribir, que no vemos desde aqui.
  let turnStartedAt = null;
  let firstDeltaOfTurn = true;

  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());

    if (event.type === 'audio' && event.audio_event?.audio_base_64) {
      if (firstDeltaOfTurn) {
        if (turnStartedAt) {
          console.log(`[elevenlabs-realtime] latencia hasta primer audio: ${Date.now() - turnStartedAt}ms`);
        }
        firstDeltaOfTurn = false;
      }
      onAudioDelta(event.audio_event.audio_base_64);
    }
    if (event.type === 'interruption') {
      onInterrupt();
    }
    // Texto hablado por el agente (equivalente a la transcripcion de
    // salida que OpenAI entrega via response.output_audio_transcript.delta).
    if (event.type === 'agent_response' && event.agent_response_event?.agent_response) {
      onTranscriptDelta(event.agent_response_event.agent_response);
    }
    if (event.type === 'user_transcript' && event.user_transcription_event?.user_transcript) {
      turnStartedAt = Date.now();
      firstDeltaOfTurn = true;
    }
    // ElevenLabs espera un "pong" por cada "ping" para mantener la
    // conexion viva -- sin esto el socket se cierra por timeout.
    if (event.type === 'ping' && event.ping_event?.event_id) {
      socket.send(JSON.stringify({ type: 'pong', event_id: event.ping_event.event_id }));
    }
    if (event.type === 'client_error') {
      console.error('[elevenlabs-realtime] Evento de error:', JSON.stringify(event));
    }
  });

  socket.on('close', (code, reason) => {
    console.log(`[elevenlabs-realtime] Socket cerrado. code=${code} reason=${reason?.toString()}`);
  });

  socket.on('error', (err) => {
    console.error('[elevenlabs-realtime] Error de socket:', err.message);
  });

  return socket;
}

/**
 * Puente hacia Hume EVI -- alterno de PRUEBA a connectToOpenAIRealtime,
 * igual que ElevenLabs. A diferencia de OpenAI y ElevenLabs (que aceptan
 * mu-law 8kHz directamente), Hume NO soporta mu-law -- solo linear16 (PCM).
 * Por eso, a diferencia de los otros dos puentes, aqui SI hace falta
 * transcodificar en ambas direcciones (ver audioCodec.js):
 *   Twilio (mu-law 8kHz) -> Hume (linear16 8kHz): en el caso 'media' de
 *     arriba, via audioCodec.twilioMuLawToHumePcm16Base64.
 *   Hume (WAV linear16, documentado a 48kHz) -> Twilio (mu-law 8kHz): aqui
 *     abajo, via audioCodec.humeWavToTwilioMuLaw (incluye el downsample).
 *
 * Autenticacion: HUME_API_KEY directo como query param (soportado segun
 * la documentacion de Hume para este endpoint) -- no se usa el flujo de
 * access_token (Basic auth con API key + Secret key) porque esto corre
 * enteramente en el servidor, nunca se expone al cliente.
 *
 * Personalizacion: a diferencia del flujo "nativo" de Hume con Twilio
 * (donde Hume origina/maneja todo pero no hay forma de inyectar variables
 * por contacto), aqui Voxia mantiene el control de la llamada (Twilio
 * conecta a NUESTRO stream, ver humeTwilioProvider.js) y manda
 * full_name/phone_number/balance_due via session_settings.variables para
 * que el prompt de Hume (configurado en su dashboard, con placeholders
 * {{full_name}} etc.) los pueda interpolar.
 *
 * Superficie verificada contra la documentacion de Hume en 2026-07 -- como
 * toda API de terceros en evolucion, revisar shape de mensajes si algo deja
 * de funcionar (mismo espiritu que la nota sobre el webhook SIP nativo de
 * OpenAI en openaiSipProvider.js).
 */
async function connectToHumeRealtime(contact, { onAudioDelta, onTranscriptDelta, onInterrupt }) {
  if (!env.hume.apiKey || !env.hume.configId) {
    throw new Error('Credenciales de Hume no configuradas (HUME_API_KEY / HUME_CONFIG_ID).');
  }

  const url = `wss://api.hume.ai/v0/evi/chat?config_id=${encodeURIComponent(env.hume.configId)}&api_key=${encodeURIComponent(env.hume.apiKey)}`;
  const socket = new WebSocket(url);

  socket.on('open', () => {
    console.log('[hume-realtime] Socket abierto, enviando session_settings.');
    socket.send(
      JSON.stringify({
        type: 'session_settings',
        audio: { encoding: 'linear16', sample_rate: 8000, channels: 1 },
        variables: {
          full_name: contact.full_name || '',
          phone_number: contact.phone_number,
          balance_due: contact.balance_due ?? '',
        },
      })
    );
  });

  // Misma instrumentacion de latencia que los otros dos proveedores, con
  // la misma salvedad que ElevenLabs: el reloj arranca en el transcript
  // final del usuario (user_message con interim=false), no en un evento de
  // silencio-detectado puro -- Hume tampoco expone ese evento por separado.
  let turnStartedAt = null;
  let firstDeltaOfTurn = true;

  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());

    // Diagnostico temporal: loguea CADA tipo de mensaje que manda Hume --
    // a diferencia de OpenAI/ElevenLabs, aqui todavia no hay suficiente
    // trafico real observado como para confiar en la lista de eventos
    // documentada sin verificarla en una llamada real (ver nota mas abajo).
    console.log(`[hume-realtime] mensaje recibido: type=${event.type}`);

    if (event.type === 'audio_output' && event.data) {
      if (firstDeltaOfTurn) {
        if (turnStartedAt) {
          console.log(`[hume-realtime] latencia hasta primer audio: ${Date.now() - turnStartedAt}ms`);
        }
        firstDeltaOfTurn = false;
      }
      const wavBuffer = Buffer.from(event.data, 'base64');
      const muLawBuffer = audioCodec.humeWavToTwilioMuLaw(wavBuffer, 8000);
      onAudioDelta(muLawBuffer.toString('base64'));
    }
    if (event.type === 'user_interruption') {
      onInterrupt();
    }
    // Texto hablado por el agente (equivalente a la transcripcion de
    // salida de los otros dos proveedores).
    if (event.type === 'assistant_message' && event.message?.content) {
      onTranscriptDelta(event.message.content);
    }
    if (event.type === 'user_message' && event.interim === false) {
      turnStartedAt = Date.now();
      firstDeltaOfTurn = true;
    }
    if (event.type === 'error') {
      console.error('[hume-realtime] Evento de error:', JSON.stringify(event));
    }
  });

  socket.on('close', (code, reason) => {
    console.log(`[hume-realtime] Socket cerrado. code=${code} reason=${reason?.toString()}`);
  });

  socket.on('error', (err) => {
    console.error('[hume-realtime] Error de socket:', err.message);
  });

  return socket;
}

module.exports = { registerTwilioMediaStreamHandler };
