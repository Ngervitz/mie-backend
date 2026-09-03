const app = require('./app');
const env = require('./config/env');
const logger = require('./lib/logger');
const smsRouter = require('./routes/sms');
const smsContactsRouter = require('./routes/sms-contacts');
const emailRouter = require('./routes/email');
const aiVisibilityRouter = require('./routes/ai-visibility');
const rechazadosRouter = require('./routes/rechazados');
const {
  requireDashboardPermission,
} = require('./middleware/requireDashboardPermission');

// SMS campaigns (Notifyme) — registered here per module isolation scope.
app.use('/sms', requireDashboardPermission('sms'), smsRouter);
// SMS contacts import (Credizona CSV sync via IT) — /sms/contacts*
app.use('/sms', requireDashboardPermission('sms'), smsContactsRouter);
// Email campaigns — registered here per module isolation scope.
app.use('/email', requireDashboardPermission('email'), emailRouter);
// AI Visibility (weekly LLM prompts) — registered here per module isolation scope.
app.use(
  '/ai-visibility',
  requireDashboardPermission('ai-visibility'),
  aiVisibilityRouter,
);
app.use(
  '/rechazados',
  requireDashboardPermission('rechazados'),
  rechazadosRouter,
);

app.listen(env.port, () => {
  logger.info('MIE Backend listening', { port: env.port, nodeEnv: env.nodeEnv });
});
