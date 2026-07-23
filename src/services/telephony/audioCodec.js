/**
 * Conversion de audio para el puente con Hume EVI (services/telephony/humeTwilioProvider.js
 * y la funcion connectToHumeRealtime en ws/twilioMediaStreamHandler.js).
 *
 * Necesario porque, a diferencia de OpenAI y ElevenLabs (que aceptan
 * audio/pcmu = mu-law 8kHz nativamente, el mismo formato que usa Twilio
 * Media Streams), Hume EVI NO soporta mu-law -- solo linear16 (PCM). Aqui
 * se hace manualmente lo que en los otros dos proveedores no hacia falta:
 * mu-law <-> PCM16, y el remuestreo de la tasa de muestreo de salida de
 * Hume (48kHz) a la que espera Twilio (8kHz).
 *
 * Algoritmo de mu-law (G.711) estandar -- misma referencia que usan
 * librerias como libsndfile/SoX, no es una implementacion propia inventada.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function muLawDecodeSample(muLawByte) {
  muLawByte = ~muLawByte & 0xff;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

function muLawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Buffer de bytes mu-law (lo que manda Twilio) -> Int16Array de PCM16. */
function muLawBufferToPcm16(muLawBuffer) {
  const pcm = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    pcm[i] = muLawDecodeSample(muLawBuffer[i]);
  }
  return pcm;
}

/** Int16Array de PCM16 -> Buffer de bytes mu-law (lo que espera Twilio). */
function pcm16ToMuLawBuffer(pcm16) {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = muLawEncodeSample(pcm16[i]);
  }
  return out;
}

// Filtro paso-bajo de un polo (RC), aplicado en cascada varias veces para
// aproximar un filtro de orden mayor con mejor caida en la banda de
// rechazo. Sin esto (la version anterior solo promediaba N muestras
// consecutivas, un filtro muy debil), el contenido por encima de la nueva
// frecuencia de Nyquist se "dobla" hacia abajo (aliasing) en vez de
// eliminarse -- eso suena metalico/granuloso, facil de confundir con "la
// IA suena robotica" cuando en realidad es un artefacto de la conversion
// de audio, no de la voz real del proveedor.
function onePoleLowPass(signal, sampleRate, cutoffHz) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float64Array(signal.length);
  let prev = signal.length > 0 ? signal[0] : 0;
  for (let i = 0; i < signal.length; i++) {
    prev += alpha * (signal[i] - prev);
    out[i] = prev;
  }
  return out;
}

function lowPassFilter(pcm16, sampleRate, cutoffHz, passes = 4) {
  let signal = Float64Array.from(pcm16);
  for (let p = 0; p < passes; p++) {
    signal = onePoleLowPass(signal, sampleRate, cutoffHz);
  }
  return signal;
}

/**
 * Remuestrea PCM16 aplicando primero un paso-bajo anti-aliasing (ver
 * lowPassFilter) y despues decimando -- a diferencia de la version
 * original (que solo promediaba N muestras, un filtro demasiado debil
 * para el contenido de voz). fromRate debe ser multiplo entero de toRate.
 */
function downsamplePcm16(pcm16, fromRate, toRate) {
  const ratio = fromRate / toRate;
  if (!Number.isInteger(ratio)) {
    throw new Error(`downsamplePcm16: ${fromRate} no es multiplo entero de ${toRate}.`);
  }

  // Corta un poco antes de la Nyquist del destino (toRate/2) para dejar
  // margen de transicion al filtro de un polo, que no cae de golpe.
  const cutoffHz = toRate / 2 - 400;
  const filtered = lowPassFilter(pcm16, fromRate, cutoffHz, 4);

  const outLength = Math.floor(pcm16.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const sample = Math.round(filtered[i * ratio]);
    out[i] = Math.max(-32768, Math.min(32767, sample));
  }
  return out;
}

/**
 * Parser minimo de WAV (RIFF/PCM) -- busca el subchunk "data" en vez de
 * asumir un header fijo de 44 bytes, por si Hume agrega chunks extra.
 * Devuelve la tasa de muestreo real del archivo y el PCM crudo (sin
 * header), para no asumir a ciegas que siempre son los 48kHz documentados.
 */
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('parseWav: el buffer no tiene un header RIFF/WAVE valido.');
  }

  let offset = 12;
  let sampleRate = null;
  let bitsPerSample = null;
  let channels = null;
  let dataStart = null;
  let dataLength = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(chunkDataStart + 2);
      sampleRate = buffer.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === 'data') {
      dataStart = chunkDataStart;
      dataLength = chunkSize;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
    if (dataStart !== null && sampleRate !== null) break;
  }

  if (dataStart === null || sampleRate === null) {
    throw new Error('parseWav: no se encontraron los subchunks "fmt " y/o "data".');
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    data: buffer.subarray(dataStart, dataStart + dataLength),
  };
}

function pcm16BufferToInt16Array(buffer) {
  const arr = new Int16Array(buffer.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = buffer.readInt16LE(i * 2);
  return arr;
}

/**
 * Convierte un segmento WAV de salida de Hume (linear16, la tasa que sea)
 * directamente al buffer mu-law 8kHz que Twilio necesita en el evento
 * "media". Punto de entrada unico para el lado Hume->Twilio.
 */
function humeWavToTwilioMuLaw(wavBuffer, targetSampleRate = 8000) {
  const { sampleRate, data } = parseWav(wavBuffer);
  let pcm16 = pcm16BufferToInt16Array(data);
  if (sampleRate !== targetSampleRate) {
    pcm16 = downsamplePcm16(pcm16, sampleRate, targetSampleRate);
  }
  return pcm16ToMuLawBuffer(pcm16);
}

/**
 * Convierte un frame mu-law de Twilio (lo que llega en el evento "media")
 * al PCM16 que Hume espera, ya en base64 listo para el mensaje audio_input.
 * Punto de entrada unico para el lado Twilio->Hume.
 */
function twilioMuLawToHumePcm16Base64(muLawBase64) {
  const muLawBuffer = Buffer.from(muLawBase64, 'base64');
  const pcm16 = muLawBufferToPcm16(muLawBuffer);
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
}

module.exports = {
  muLawBufferToPcm16,
  pcm16ToMuLawBuffer,
  downsamplePcm16,
  lowPassFilter,
  parseWav,
  humeWavToTwilioMuLaw,
  twilioMuLawToHumePcm16Base64,
};
