const express = require('express');
const jobsRouter = require('./routes/jobs');
const logger = require('./lib/logger');

const app = express();

app.use(express.json());
app.use('/jobs', jobsRouter);

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
