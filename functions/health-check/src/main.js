export default async ({ req, res, log }) => {
  const health = {
    ok: true,
    service: "AI Agent Router",
    provider: "NVIDIA NIM",
    path: req.path || "/",
    timestamp: new Date().toISOString(),
    message: "Health check OK",
  };

  log(`HEALTH_CHECK_OK ${JSON.stringify(health)}`);

  return res.json(health);
};
