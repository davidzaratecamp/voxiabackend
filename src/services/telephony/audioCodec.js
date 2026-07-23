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

/**
 * Remuestrea PCM16 por decimacion con promedio simple (no es un resampler
 * de calidad de estudio, pero es mas que suficiente para voz telefonica y
 * evita el aliasing peor que dejaria una decimacion "a lo bruto" tomando
 * una muestra de cada N). fromRate debe ser multiplo entero de toRate.
 */
function downsamplePcm16(pcm16, fromRate, toRate) {
  const ratio = fromRate / toRate;
  if (!Number.isInteger(ratio)) {
    throw new Error(`downsamplePcm16: ${fromRate} no es multiplo entero de ${toRate}.`);
  }
  const outLength = Math.floor(pcm16.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    const start = i * ratio;
    for (let j = 0; j < ratio; j++) sum += pcm16[start + j];
    out[i] = Math.round(sum / ratio);
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
  parseWav,
  humeWavToTwilioMuLaw,
  twilioMuLawToHumePcm16Base64,
};
