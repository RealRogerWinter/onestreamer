const express = require('express');
const router = express.Router();

// Audio optimization endpoints. The service is shared via `app.locals` so
// session state (monitorSession / updateSessionStats / getSessionReport)
// is consistent with the rest of the running process.

function getService(req, res) {
  const service = req.app.locals.audioOptimizationService;
  if (!service) {
    res.status(500).json({ error: 'audioOptimizationService not initialized' });
    return null;
  }
  return service;
}

router.get('/optimization-settings', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  res.json({
    constraints: service.getOptimizedConstraints('streaming'),
    rtpParameters: service.getOptimizedRtpParameters(),
    config: service.config,
  });
});

router.get('/profile/:profile', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  const { profile } = req.params;
  res.json({ profile, constraints: service.getOptimizedConstraints(profile) });
});

router.post('/monitor/:sessionId', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  const { sessionId } = req.params;
  const { producerId } = req.body;
  const session = service.monitorSession(sessionId, producerId);
  res.json({ success: true, session });
});

router.post('/stats/:sessionId', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  const { sessionId } = req.params;
  service.updateSessionStats(sessionId, req.body);
  res.json({ success: true });
});

router.get('/report/:sessionId', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  const { sessionId } = req.params;
  const report = service.getSessionReport(sessionId);
  if (report) {
    res.json(report);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

router.get('/global-stats', (req, res) => {
  const service = getService(req, res);
  if (!service) return;
  res.json(service.stats.globalStats);
});

module.exports = router;
