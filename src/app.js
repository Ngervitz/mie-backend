const express = require('express');
const jobsRouter = require('./routes/jobs');
const reportsRouter = require('./routes/reports');
const hugoRouter = require('./routes/hugo');
const socialCommentsRouter = require('./routes/social-comments');
const socialConversationsRouter = require('./routes/social-conversations');
const liquidityCycleRouter = require('./routes/liquidity-cycle');
const bcuUsuraRateRouter = require('./routes/bcu-usura-rate');
const competitorActivityPredictionsRouter = require('./routes/competitor-activity-predictions');
const mlNotesRouter = require('./routes/ml-notes');
const authRouter = require('./routes/auth');
const { requireAuth } = require('./middleware/auth');
const logger = require('./lib/logger');

const app = express();

app.use(express.json());
app.use('/', authRouter);
app.use(requireAuth);
app.use(express.static('public'));
app.use('/jobs', jobsRouter);
app.use('/reports', reportsRouter);
app.use('/hugo', hugoRouter);
app.use('/api/social-comments', socialCommentsRouter);
app.use('/api/social-conversations', socialConversationsRouter);
app.use('/api/liquidity-cycle', liquidityCycleRouter);
app.use('/api/bcu-usura-rate', bcuUsuraRateRouter);
app.use(
  '/competitor-activity-predictions',
  competitorActivityPredictionsRouter,
);
app.use('/ml-notes', mlNotesRouter);

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
