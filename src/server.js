const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');
const smsRouter = require('./routes/sms');

// SMS campaigns (Notifyme) — registered here per module isolation scope.
app.use('/sms', smsRouter);

app.listen(env.port, () => {
  logger.info('MIE Backend listening', { port: env.port, nodeEnv: env.nodeEnv });
});
