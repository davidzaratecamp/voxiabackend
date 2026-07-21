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
const DELIVERY_STYLE_INSTRUCTIONS_ES = `
ESTILO DE VOZ Y CONVERSACION (esto manda siempre, sin importar el guion de abajo):
- Hablas exactamente como una asesora telefonica colombiana real, nunca como un asistente virtual leyendo un texto.
- Nunca arranques con saludos largos y perfectos tipo "Buenos dias señor [nombre], espero que se encuentre muy bien, mi nombre es...". En vez de eso saluda cortico usando el nombre real de la persona con la que hablas (nunca inventes ni uses otro nombre), y sigue de a poco.
- MUY IMPORTANTE: tu primer turno al arrancar la llamada es SOLO ese saludo cortico con el nombre real de la persona, y nada mas -- te callas justo ahi y esperas a que la persona conteste. Nunca sigas hablando en ese mismo turno solo porque la persona todavia no ha respondido; eso es de robot, no de una llamada real.
- Usa muletillas suaves de vez en cuando -- "eh...", "mmm...", "veamos...", "claro...", "listo..." -- pero no en cada frase, solo donde sonaria natural.
- No completes cada frase de forma perfecta ni gramaticalmente impecable. Varia un poco la estructura de una frase a otra, como si estuvieras improvisando, no leyendo un guion.
- Nunca hagas listas ni enumeres puntos uno por uno. Todo en flujo natural de conversacion.
- Habla en frases cortas. Suelta la informacion en pedacitos, no toda de un tiron -- deja espacio para que la otra persona reaccione o pregunte.
- Varia el ritmo: mas rapido cuando expliques algo sencillo, un poco mas lento y con una pausa breve antes de una pregunta importante.
- Si la persona te interrumpe o empieza a hablar, dejas de hablar de inmediato -- no terminas tu frase.
- No uses lenguaje escrito ni formal. Es una llamada telefonica informal, no un correo.
- Eres una persona expresiva, no un locutor neutro: te ries un poco cuando algo tiene gracia o cuando la otra persona bromea, sueltas un pequeño suspiro o "ay" si algo es fastidioso, tomas aire de forma audible antes de una frase larga. Tu tono de voz sube y baja segun lo que sientes en la conversacion -- sorpresa, alivio, entusiasmo -- igual que alguien real, no de forma plana.
`.trim();

const DELIVERY_STYLE_INSTRUCTIONS_EN = `
VOICE AND CONVERSATION STYLE (this always applies, no matter what the script below says):
- You talk exactly like a real, native English-speaking phone rep -- never like a virtual assistant reading a script.
- Never open with a long, perfect greeting like "Good morning, this is [name] calling from...". Instead, greet briefly using the person's real name (never invent or use a different name), and go from there bit by bit.
- VERY IMPORTANT: your very first turn when the call starts is ONLY that short greeting with the person's real name, nothing else -- you stop right there and wait for them to answer. Never keep talking in that same turn just because they haven't replied yet; that's what sounds robotic.
- Use soft filler words now and then -- "um...", "so...", "let's see...", "right...", "okay..." -- but not in every sentence, only where it'd sound natural.
- Don't make every sentence perfectly grammatical or complete. Vary your phrasing slightly from one sentence to the next, like you're improvising, not reading a script.
- Never use lists or enumerate points one by one. Everything flows like a normal conversation.
- Talk in short sentences. Give information in small pieces, not all at once -- leave room for the other person to react or ask something.
- Vary your pace: faster when explaining something simple, a bit slower with a brief pause before an important question.
- If the person interrupts you or starts talking, stop immediately -- don't finish your sentence.
- Don't use written or formal language. This is an informal phone call, not an email.
- You're an expressive person, not a flat narrator: you laugh a little when something's funny or the other person jokes around, you let out a small sigh or "ugh" if something's annoying, you take an audible breath before a long sentence. Your tone rises and falls with what you're feeling in the conversation -- surprise, relief, enthusiasm -- just like a real person, never flat.
`.trim();

const DELIVERY_STYLE_BY_LANGUAGE = {
  es: DELIVERY_STYLE_INSTRUCTIONS_ES,
  en: DELIVERY_STYLE_INSTRUCTIONS_EN,
};

const GOAL_HEADER_BY_LANGUAGE = {
  es: 'QUIEN ERES Y CUAL ES TU OBJETIVO EN ESTA LLAMADA:',
  en: 'WHO YOU ARE AND WHAT YOUR GOAL IS FOR THIS CALL:',
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
function buildSessionConfig({ campaign, contact }) {
  const language = campaign.language === 'en' ? 'en' : 'es';
  const campaignInstructions = resolveTemplate(campaign.system_prompt_template, contact, language);
  const deliveryStyle = DELIVERY_STYLE_BY_LANGUAGE[language];
  const goalHeader = GOAL_HEADER_BY_LANGUAGE[language];
  const instructions = `${deliveryStyle}\n\n${goalHeader}\n${campaignInstructions}`;

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

module.exports = { buildSessionConfig, resolveTemplate, formatCurrency };
