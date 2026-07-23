const env = require('../../config/env');
const TwilioRealtimeProvider = require('./twilioRealtimeProvider');
const OpenAISipProvider = require('./openaiSipProvider');

const PROVIDER_CLASSES = {
  twilio_realtime: TwilioRealtimeProvider,
  openai_native_sip: OpenAISipProvider,
};

const registry = new Map();

for (const providerKey of env.telephony.enabledProviders) {
  const ProviderClass = PROVIDER_CLASSES[providerKey];
  if (!ProviderClass) {
    console.warn(`[providerFactory] Proveedor desconocido en TELEPHONY_PROVIDERS: "${providerKey}" (ignorado).`);
    continue;
  }
  registry.set(providerKey, new ProviderClass());
}

if (registry.size === 0) {
  console.warn('[providerFactory] Ningun proveedor de telefonia habilitado. Revisa TELEPHONY_PROVIDERS en .env.');
}

function getProvider(providerKey) {
  const provider = registry.get(providerKey);
  if (!provider) {
    throw new Error(
      `Proveedor "${providerKey}" no esta habilitado. Proveedores activos: ${[...registry.keys()].join(', ') || 'ninguno'}.`
    );
  }
  return provider;
}

function isProviderEnabled(providerKey) {
  return registry.has(providerKey);
}

function listEnabledProviders() {
  return [...registry.keys()];
}

module.exports = { getProvider, isProviderEnabled, listEnabledProviders };
