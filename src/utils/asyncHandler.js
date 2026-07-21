// Evita el try/catch repetido en cada controller: envuelve un handler async
// y reenvia cualquier error al middleware de errores de Express.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
