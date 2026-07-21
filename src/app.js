const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const env = require('./config/env');
const routes = require('./routes');

const app = express();

// Necesario para que req.protocol/host sean confiables detras de un
// proxy/load balancer en produccion (relevante para la validacion de firma
// de Twilio en webhookController.js, que reconstruye la URL invocada).
if (env.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({ origin: env.corsOrigin }));
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));

// Twilio envia sus webhooks como x-www-form-urlencoded; el resto de la API
// usa JSON.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/api/v1', routes);

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error(err);
  res.status(statusCode).json({ error: err.message || 'Error interno del servidor.' });
});

module.exports = app;
