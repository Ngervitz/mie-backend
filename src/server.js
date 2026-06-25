const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');

app.listen(env.port, () => {
  logger.info('MIE Backend listening', { port: env.port, nodeEnv: env.nodeEnv });
});
