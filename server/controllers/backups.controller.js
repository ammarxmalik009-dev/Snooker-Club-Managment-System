// Thin layer between HTTP and the backup service (admin only, see routes/backups.routes.js).

const backupService = require("../services/backup.service");
const { sendSuccess } = require("../utils/response");

async function status(req, res) {
  sendSuccess(res, "Backups fetched successfully", await backupService.backupStatus());
}

// "Backup Now" button
async function create(req, res) {
  const result = await backupService.runBackup();
  sendSuccess(res, `Backup saved: ${result.file}`, { file: result.file, size: result.size, createdAt: result.createdAt, counts: result.counts }, 201);
}

// Download one file (e.g. to copy it to a USB drive)
async function download(req, res) {
  const filePath = backupService.backupFilePath(req.params.file);
  res.download(filePath, req.params.file);
}

module.exports = { status, create, download };
