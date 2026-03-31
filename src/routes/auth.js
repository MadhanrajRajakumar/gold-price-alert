const express = require("express");
const {
  clearUserSession,
  getAuthenticatedUser,
  loginOrCreateUser,
  serializeUser,
} = require("../services/authService");

const router = express.Router();

router.post("/login", async (request, response, next) => {
  try {
    const user = await loginOrCreateUser(request.body.email, response);
    response.status(201).json({
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (request, response, next) => {
  try {
    const user = await getAuthenticatedUser(request);

    if (!user) {
      response.status(401).json({
        error: "Authentication required",
      });
      return;
    }

    response.json({
      user: serializeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (request, response, next) => {
  try {
    await clearUserSession(request, response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
