// /api/backups endpoints: backup status and files, "Backup Now", download a file.
// Admins only: a backup holds every record of the club (and the users' password hashes).

const express = require("express");
const { requirePermission } = require("../middleware/auth");
const controller = require("../controllers/backups.controller");

const router = express.Router();

router.use(requirePermission("backups:manage"));
router.get("/", controller.status);
router.post("/", controller.create);
router.get("/:file", controller.download);

module.exports = router;
