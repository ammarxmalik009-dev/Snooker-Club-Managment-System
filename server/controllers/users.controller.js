// User management (admin only - enforced in routes/users.routes.js).

const { matchedData } = require("express-validator");
const usersService = require("../services/users.service");
const { sendSuccess } = require("../utils/response");

const bodyData = (req) => matchedData(req, { locations: ["body"] });

async function list(req, res) {
  const users = await usersService.listUsers(matchedData(req, { locations: ["query"] }));
  sendSuccess(res, "Users fetched successfully", { users, activeAdmins: await usersService.countActiveAdmins() });
}

async function getOne(req, res) {
  sendSuccess(res, "User fetched successfully", await usersService.getUserById(req.params.id));
}

async function create(req, res) {
  const user = await usersService.createUser(bodyData(req), req.user);
  sendSuccess(res, `User ${user.username} created`, user, 201);
}

async function update(req, res) {
  const user = await usersService.updateUser(req.params.id, bodyData(req), req.user);
  sendSuccess(res, `User ${user.username} updated`, user);
}

async function setPassword(req, res) {
  const { password } = bodyData(req);
  const user = await usersService.setPassword(req.params.id, password, req.user, { currentSessionId: req.authSession._id });
  sendSuccess(res, `Password changed for ${user.username}`, user);
}

module.exports = { list, getOne, create, update, setPassword };
