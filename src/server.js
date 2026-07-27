const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');
const smsRouter = require('./routes/sms');
const smsContactsRouter = require('./routes/sms-contacts');

// SMS campaigns (Notifyme) — registered here per module isolation scope.
app.use('/sms', smsRouter);
// SMS contacts import (Credizona CSV sync via IT) — /sms/contacts*
app.use('/sms', smsContactsRouter);

app.listen(env.port, () => {
  logger.info('MIE Backend listening', { port: env.port, nodeEnv: env.nodeEnv });
});
