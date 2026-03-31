const crypto = require("crypto");
const prisma = require("../lib/prisma");

const SESSION_COOKIE_NAME = "gold_price_alert_session";
const SESSION_TTL_DAYS = 30;

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  parts.push("Path=/");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join("; ");
}

async function createUserSession(user, response) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.session.create({
    data: {
      token,
      expires_at: expiresAt,
      user_id: user.id,
    },
  });

  response.setHeader(
    "Set-Cookie",
    buildCookie(SESSION_COOKIE_NAME, token, {
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    }),
  );
}

async function clearUserSession(request, response) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies[SESSION_COOKIE_NAME];

  if (token) {
    await prisma.session.deleteMany({
      where: { token },
    });
  }

  response.setHeader(
    "Set-Cookie",
    buildCookie(SESSION_COOKIE_NAME, "", {
      maxAge: 0,
    }),
  );
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    telegram_chat_id: user.telegram_chat_id,
    telegram_connected: Boolean(user.telegram_chat_id),
    last_payment_date: user.last_payment_date
      ? toLocalDateString(user.last_payment_date)
      : null,
  };
}

async function loginOrCreateUser(email, response) {
  const normalizedEmail = email.trim().toLowerCase();

  if (!validateEmail(normalizedEmail)) {
    const error = new Error("Please enter a valid email address");
    error.statusCode = 400;
    throw error;
  }

  const user = await prisma.user.upsert({
    where: { email: normalizedEmail },
    update: {},
    create: { email: normalizedEmail },
  });

  await createUserSession(user, response);
  return user;
}

async function getAuthenticatedUser(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!session) {
    return null;
  }

  if (session.expires_at.getTime() < Date.now()) {
    await prisma.session.delete({
      where: { token },
    });
    return null;
  }

  return session.user;
}

async function requireAuth(request, response, next) {
  try {
    const user = await getAuthenticatedUser(request);

    if (!user) {
      response.status(401).json({
        error: "Authentication required",
      });
      return;
    }

    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  clearUserSession,
  getAuthenticatedUser,
  loginOrCreateUser,
  requireAuth,
  serializeUser,
  toLocalDateString,
};
