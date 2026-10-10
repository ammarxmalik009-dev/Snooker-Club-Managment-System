// GET /api/health - tells you whether the server and the database are working.

const { getDatabaseStatus } = require("../config/db");
const { sendSuccess } = require("../utils/response");
const { version } = require("../../package.json");

function getHealth(req, res) {
  const database = getDatabaseStatus();
  const data = {
    server: "running",
    database,
    version,
    uptimeSeconds: Math.round(process.uptime()),
    serverTime: new Date().toISOString(), // the server's clock (used later for session timers)
  };

  if (database !== "connected") {
    // 503 = "Service Unavailable": the server runs, but can't do its job without the database.
    // The details are still included so you can see what is wrong.
    return res.status(503).json({ success: false, message: "Database is not connected", data });
  }
  return sendSuccess(res, "Server and database are healthy", data);
}

module.exports = { getHealth };
