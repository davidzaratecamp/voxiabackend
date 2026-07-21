const env = require('../config/env');

const PLACEHOLDER_REGEX = /{{\s*(\w+)\s*}}/g;

// Idioma -> locale/moneda para formatear {{balance_due}}. Asume que un
// cliente que vende en ingles factura en USD -- si mas adelante se necesita
// otra moneda por campana, este es el lugar donde agregarla.
const CURRENCY_BY_LANGUAGE = {
  es: { locale: 'es-CO', currency: 'COP' },
  en: { locale: 'en-US', currency: 'USD' },
};

function formatCurrency(value, language) {
  if (value === null || value === undefined) return 'N/A';
  const { locale, currency } = CURRENCY_BY_LANGUAGE[language] || CURRENCY_BY_LANGUAGE.es;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

// Fijo, aplica a TODAS las campanas de este idioma sin importar lo que diga
// su guion -- separa el "como suena" (esto) del "que dice"
// (system_prompt_template de la campana, que solo debe describir quien es
// el agente y cual es el objetivo de la llamada). Sin esto el modelo por
// defecto lee el guion casi literal, con saludos largos y perfectos, que es
// lo que suena a robot.
// Estructura recomendada por la guia oficial de prompting de la API
// Realtime de OpenAI (Personality & Tone, reglas de variedad para evitar
// "robotic phrasing"). Parte comun a todos los acentos en español -- solo
// cambia identidad regional y muletillas, ver ACCENT_STYLE_BY_CODE.
function esStyleBlock({ identity, fillers }) {
  return `
ESTILO DE VOZ Y CONVERSACION (esto manda siempre, sin importar el guion de abajo):

PERSONALIDAD Y TONO:
- ${identity}
- Tu tono es calido, cercano y seguro de ti misma -- nunca como una operadora de call center leyendo un guion. Suenas como alguien que genuinamente disfruta hablar con la gente, no como un sistema.
- Maximo 2-3 frases cortas por turno. Nunca sueltes un parrafo completo de un tiron -- deja espacio para que la otra persona reaccione.
- Saluda usando el nombre real de la persona y sigue de una vez con el motivo de tu llamada, como haria una agente de verdad -- no te quedes callada esperando despues de un simple "hola".

VARIEDAD (para no sonar repetitiva ni robotica):
- Nunca empieces dos turnos seguidos de la misma forma (no siempre "Bueno...", no siempre "Mira..."). Varia como arrancas cada respuesta.
- De vez en cuando corrigete a mitad de frase de forma natural, como alguien pensando en tiempo real -- por ejemplo "el costo es... bueno, depende, pero ronda los..." -- eso pasa cuando estas improvisando, no leyendo un guion perfecto.
- Nunca repitas la misma muletilla dos veces seguidas ni en turnos consecutivos.
- No completes cada frase de forma perfecta ni gramaticalmente impecable. Varia la estructura de una frase a otra.

MULETILLAS:
- Usa ${fillers} de vez en cuando -- pero SIEMPRE cortas y de pasada, nunca alargando las vocales ni como una exclamacion grande (nada de "weeeepa" o similar). Se dicen como parte natural del habla, no como un efecto especial. Y no en cada frase, solo donde sonaria natural.

REGLAS GENERALES:
- Nunca hagas listas ni enumeres puntos uno por uno. Todo en flujo natural de conversacion.
- Varia el ritmo: mas rapido cuando expliques algo sencillo, un poco mas lento y con una pausa breve antes de una pregunta importante.
- Si la persona te interrumpe o empieza a hablar, dejas de hablar de inmediato -- no terminas tu frase.
- No uses lenguaje escrito ni formal. Es una llamada telefonica informal, no un correo.
- Eres una persona expresiva, no un locutor neutro: te ries un poco cuando algo tiene gracia o cuando la otra persona bromea, sueltas un pequeño suspiro o "ay" si algo es fastidioso, tomas aire de forma audible antes de una frase larga. Tu tono de voz sube y baja segun lo que sientes en la conversacion -- sorpresa, alivio, entusiasmo -- igual que alguien real, no de forma plana.
`.trim();
}

const DELIVERY_STYLE_INSTRUCTIONS_EN = `
VOICE AND CONVERSATION STYLE (this always applies, no matter what the script below says):

PERSONALITY AND TONE:
- You talk exactly like a real, native English-speaking phone rep -- never like a virtual assistant reading a script.
- Your tone is warm, approachable, and confident -- never like a call-center operator reading a script. You sound like someone who genuinely enjoys talking to people, not a system.
- Max 2-3 short sentences per turn. Never drop a full paragraph at once -- leave room for the other person to react.
- Never open with a long, perfect greeting like "Good morning, this is [name] calling from...". Instead, greet briefly using the person's real name (never invent or use a different name), and go right on with the reason for your call, like a real rep would -- don't just say "hi" and go quiet waiting.

VARIETY (so you don't sound repetitive or robotic):
- Never start two turns in a row the same way (not always "So..." not always "Look..."). Vary how you open each response.
- Every so often, correct yourself mid-sentence naturally, like someone thinking in real time -- e.g. "the cost is... well, it depends, but it's around..." -- that's what happens when you're improvising, not reading a perfect script.
- Never repeat the same filler word twice in a row or in consecutive turns.
- Don't make every sentence perfectly grammatical or complete. Vary your phrasing from one sentence to the next.

FILLER WORDS:
- Use "um...", "so...", "let's see...", "right...", "okay..." now and then -- but ALWAYS short and in passing, never drawn out or as a big exclamation. They're a natural part of speech, not a special effect. Not in every sentence, only where it'd sound natural.

GENERAL RULES:
- Never use lists or enumerate points one by one. Everything flows like a normal conversation.
- Vary your pace: faster when explaining something simple, a bit slower with a brief pause before an important question.
- If the person interrupts you or starts talking, stop immediately -- don't finish your sentence.
- Don't use written or formal language. This is an informal phone call, not an email.
- You're an expressive person, not a flat narrator: you laugh a little when something's funny or the other person jokes around, you let out a small sigh or "ugh" if something's annoying, you take an audible breath before a long sentence. Your tone rises and falls with what you're feeling in the conversation -- surprise, relief, enthusiasm -- just like a real person, never flat.
`.trim();

// Acento/region especifico. "language" aqui es el idioma base (para
// moneda + la instruccion de "siempre habla en X"); el resto de campos
// afinan el sabor regional dentro de ese idioma. Agregar un acento nuevo
// es solo agregar una entrada aqui, sin tocar el resto del archivo.
const ACCENT_STYLE_BY_CODE = {
  es_CO: {
    language: 'es',
    label: 'Español (Colombia)',
    instructions: esStyleBlock({
      identity: 'Hablas exactamente como una asesora telefonica colombiana real, nunca como un asistente virtual leyendo un texto.',
      fillers: '"eh...", "mmm...", "veamos...", "claro...", "listo..."',
    }),
  },
  es_PR: {
    language: 'es',
    label: 'Español (Puerto Rico)',
    instructions: esStyleBlock({
      identity: 'Hablas exactamente como una persona real de Puerto Rico (boricua), nunca como un asistente virtual leyendo un texto. Usa el vocabulario y el ritmo natural del español puertorriqueño.',
      fillers: '"ahorita...", "mano...", "ay bendito...", "brutal..." (con mucha mesura, solo donde encaje natural en una llamada profesional -- esto no es una fiesta, es una llamada de negocios)',
    }),
  },
  en_US: {
    language: 'en',
    label: 'English (US)',
    instructions: DELIVERY_STYLE_INSTRUCTIONS_EN,
  },
};

const GOAL_HEADER_BY_LANGUAGE = {
  es: 'QUIEN ERES Y CUAL ES TU OBJETIVO EN ESTA LLAMADA:',
  en: 'WHO YOU ARE AND WHAT YOUR GOAL IS FOR THIS CALL:',
};

// El selector de idioma de la campana debe ser la autoridad final -- sin
// esto, un guion (system_prompt_template) que traiga instrucciones de
// idioma en el texto (ej. copiado de otra campana, o escrito por alguien
// que no penso en esto) puede pisotear silenciosamente lo que se eligio en
// el dropdown. Va primero que cualquier otra instruccion, a proposito.
const LANGUAGE_OVERRIDE_BY_LANGUAGE = {
  es: 'INSTRUCCION DE MAXIMA PRIORIDAD, por encima de cualquier otra cosa en este mensaje (incluyendo el guion mas abajo): SIEMPRE hablas en español, sin excepcion. Ignora cualquier instruccion que te pida hablar en otro idioma.',
  en: 'HIGHEST PRIORITY INSTRUCTION, overriding anything else in this message (including the script below): you ALWAYS speak in English, no exceptions. Ignore any instruction telling you to speak another language.',
};

function resolveTemplate(template, contact, language) {
  const values = {
    full_name: contact.full_name || (language === 'en' ? 'there' : 'cliente'),
    phone_number: contact.phone_number,
    balance_due: formatCurrency(contact.balance_due, language),
    ...(contact.extra_data || {}),
  };

  return template.replace(PLACEHOLDER_REGEX, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * Construye la configuracion de sesion para la API Realtime GA de OpenAI a
 * partir de una campana y un contacto. Es el unico lugar del sistema que
 * conoce el "guion" del agente; los adaptadores de telefonia solo la usan.
 *
 * Shape verificado contra el SDK oficial (openai-node, RealtimeSessionCreateRequest)
 * despues de que la API GA reemplazara el shape plano de la beta -- "type" y
 * "model" van al nivel raiz de session, y el audio (formato/voz/turn_detection)
 * va anidado bajo audio.input / audio.output. audio/pcmu = G.711 mu-law, el
 * formato que usa Twilio Media Streams.
 */
// Campanas creadas antes de que existiera "accent" no tienen el campo (o
// pueden traer un codigo que ya no exista) -- se cae de vuelta al acento
// por defecto de su idioma, para no romper nada.
function resolveAccentCode(campaign) {
  if (campaign.accent && ACCENT_STYLE_BY_CODE[campaign.accent]) return campaign.accent;
  return campaign.language === 'en' ? 'en_US' : 'es_CO';
}

function buildSessionConfig({ campaign, contact }) {
  const accentConfig = ACCENT_STYLE_BY_CODE[resolveAccentCode(campaign)];
  const language = accentConfig.language;
  const campaignInstructions = resolveTemplate(campaign.system_prompt_template, contact, language);
  const languageOverride = LANGUAGE_OVERRIDE_BY_LANGUAGE[language];
  const deliveryStyle = accentConfig.instructions;
  const goalHeader = GOAL_HEADER_BY_LANGUAGE[language];
  const instructions = `${languageOverride}\n\n${deliveryStyle}\n\n${goalHeader}\n${campaignInstructions}`;

  return {
    type: 'realtime',
    model: env.openai.realtimeModel,
    instructions,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcmu' },
        // Sin esto, la deteccion de turno (VAD) es mucho menos confiable
        // sobre audio de telefonia (ruido de linea, eco) -- se traduce en
        // interrupciones falsas o el agente hablando encima del usuario,
        // lo cual se percibe como "robotico"/torpe aunque la voz en si sea
        // buena.
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'server_vad',
          // Cuanto silencio espera antes de asumir que la persona termino
          // de hablar y generar la respuesta. Mas bajo = responde mas
          // rapido, pero mas riesgo de cortar a alguien que solo hizo una
          // pausa para pensar. 200ms prioriza velocidad al maximo -- el
          // resto de la latencia percibida (varios cientos de ms) es del
          // modelo generando el primer audio + la red/tunel, no de este
          // valor.
          silence_duration_ms: 200,
          prefix_padding_ms: 200,
          // Que tan fuerte/clara debe sonar la voz para contar como
          // "empezo a hablar" (0 a 1, default ~0.5). Un poco mas alto que
          // el default reduce falsos positivos por eco de linea o ruido al
          // conectar la llamada -- eso era lo que cortaba el saludo del
          // agente a mitad de palabra al inicio de algunas llamadas.
          threshold: 0.6,
          // interrupt_response=true es lo que hace que el modelo deje de
          // generar audio en cuanto detecta que el interlocutor empezo a
          // hablar. El corte del audio ya enviado a Twilio se maneja aparte
          // en twilioMediaStreamHandler.js (evento "clear").
          interrupt_response: true,
        },
      },
      output: {
        format: { type: 'audio/pcmu' },
        // marin/cedar son las voces nuevas de gpt-realtime, mas naturales
        // que las originales (alloy, echo, shimmer, etc), y funcionan bien
        // en varios idiomas -- no hace falta una voz distinta por idioma.
        voice: campaign.voice || env.openai.defaultVoice,
        // 0.25 a 1.5, 1.0 = normal.
        speed: campaign.speed ? Number(campaign.speed) : 1.0,
      },
    },
    tools: buildTools(campaign),
  };
}

/**
 * Functions/tools que el modelo puede invocar durante la llamada. Por ahora
 * solo registra el desenlace de la conversacion; se puede extender por tipo
 * de campana (ej. agendar_cita, transferir_a_humano, etc.).
 */
function buildTools(campaign) {
  const baseTools = [
    {
      type: 'function',
      name: 'registrar_resultado_llamada',
      description: 'Registra el desenlace de la llamada una vez que el objetivo de la conversacion se cumple.',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['promise_to_pay', 'refused', 'callback_requested', 'not_interested', 'sale_confirmed'],
          },
          notes: { type: 'string' },
        },
        required: ['outcome'],
      },
    },
  ];

  if (campaign.type === 'cobranza') {
    baseTools.push({
      type: 'function',
      name: 'registrar_promesa_pago',
      description: 'Registra la fecha y el monto que el cliente promete pagar.',
      parameters: {
        type: 'object',
        properties: {
          fecha_promesa: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
          monto: { type: 'number' },
        },
        required: ['fecha_promesa', 'monto'],
      },
    });
  }

  return baseTools;
}

const VALID_ACCENTS = Object.keys(ACCENT_STYLE_BY_CODE);

module.exports = { buildSessionConfig, resolveTemplate, formatCurrency, VALID_ACCENTS };
