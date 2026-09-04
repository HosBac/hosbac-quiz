"use strict";

const admin = require("firebase-admin");

let initError = null;

function normalizePrivateKey(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n");
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw.trim()) return null;
  try {
    const decoded = raw.trim();
    let jsonText = decoded;
    if (/^[A-Za-z0-9+/=_-]+$/.test(decoded) && !decoded.includes("{")) {
      try { jsonText = Buffer.from(decoded, "base64").toString("utf8"); } catch (_) {}
    }
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") throw new Error("FIREBASE_SERVICE_ACCOUNT doit être un objet JSON.");
    return {
      projectId: String(parsed.project_id || parsed.projectId || process.env.FIREBASE_PROJECT_ID || "").trim(),
      clientEmail: String(parsed.client_email || parsed.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || "").trim(),
      privateKey: normalizePrivateKey(parsed.private_key || parsed.privateKey || process.env.FIREBASE_PRIVATE_KEY || process.env.PRIVATE_KEY)
    };
  } catch (error) {
    const e = new Error(`FIREBASE_SERVICE_ACCOUNT invalide: ${error.message}`);
    e.code = "FIREBASE_CONFIG_INVALID";
    e.status = 503;
    throw e;
  }
}

function buildCredentialConfig() {
  let account = null;
  try {
    account = parseServiceAccount();
  } catch (error) {
    initError = error;
    throw error;
  }

  const projectId = String(account?.projectId || process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(account?.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = normalizePrivateKey(account?.privateKey || process.env.FIREBASE_PRIVATE_KEY || process.env.PRIVATE_KEY || "");

  if (!projectId || !clientEmail || !privateKey) {
    const e = new Error("Variables Firebase Admin manquantes: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY (ou FIREBASE_SERVICE_ACCOUNT) sont requis.");
    e.code = "FIREBASE_CONFIG_MISSING";
    e.status = 503;
    initError = e;
    throw e;
  }

  return { projectId, clientEmail, privateKey };
}

function getAdmin() {
  // Singleton Firebase Admin pour instances Serverless "warm" (Vercel).
  // Ne jamais rappeler initializeApp si une app [DEFAULT] existe déjà.
  try {
    // 1) API moderne
    if (typeof admin.getApps === "function") {
      const apps = admin.getApps();
      if (Array.isArray(apps) && apps.length > 0) {
        return typeof admin.getApp === "function" ? admin.getApp() : apps[0];
      }
    }
    // 2) Compat (admin.apps)
    if (admin.apps && admin.apps.length > 0) {
      return typeof admin.app === "function" ? admin.app() : admin.apps[0];
    }

    // 3) Première initialisation uniquement
    const cfg = buildCredentialConfig();
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId: cfg.projectId,
        clientEmail: cfg.clientEmail,
        privateKey: cfg.privateKey
      })
    });
  } catch (error) {
    // Course entre deux requêtes concurrentes : l'app a été créée entre le check et initializeApp
    const msg = String(error && error.message || error || "");
    if (/already exists/i.test(msg) || /duplicate-app/i.test(msg)) {
      try {
        if (typeof admin.getApp === "function") return admin.getApp();
        if (typeof admin.app === "function") return admin.app();
        if (admin.apps && admin.apps.length) return admin.apps[0];
        if (typeof admin.getApps === "function") {
          const apps = admin.getApps();
          if (apps && apps.length) return apps[0];
        }
      } catch (_) {}
    }
    initError = error;
    console.error("[FIREBASE ADMIN INIT]", error?.message || error, error?.stack || "");
    throw error;
  }
}

function authError(message = "Unauthorized", status = 401, cause = null) {
  const e = new Error(message);
  e.status = status;
  e.code = status === 401 ? "AUTH_INVALID" : "AUTH_ERROR";
  if (cause) e.cause = cause;
  return e;
}

function extractBearerToken(req) {
  const raw = String(req?.headers?.authorization || "").trim();
  if (!raw || !/^Bearer\s+\S+$/i.test(raw)) throw authError("Token manquant", 401);
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw authError("Token manquant", 401);
  return token;
}

async function requireAuth(req) {
  let token;
  try {
    token = extractBearerToken(req);
  } catch (error) {
    throw error;
  }

  let firebase;
  try {
    firebase = getAdmin();
  } catch (error) {
    // Infrastructure Firebase indisponible : signal explicite, jamais une exception non gérée.
    const e = new Error("Service d'authentification temporairement indisponible.");
    e.status = 503;
    e.code = "FIREBASE_UNAVAILABLE";
    e.cause = error;
    throw e;
  }

  try {
    return await firebase.auth().verifyIdToken(token);
  } catch (error) {
    console.warn("[FIREBASE AUTH] Token invalide ou expiré:", error?.code || error?.message || error);
    throw authError("Unauthorized", 401, error);
  }
}

async function requireAdmin(req) {
  const decoded = await requireAuth(req);
  const firebase = getAdmin();
  const db = firebase.firestore();
  const snap = await db.collection("users").doc(decoded.uid).get();
  const d = snap.exists ? snap.data() : {};
  if (d.role !== "admin" && d.isAdmin !== true) {
    const e = new Error("Droits administrateur requis.");
    e.status = 403;
    throw e;
  }
  return { decoded, user: d };
}

function json(res, status, payload) {
  return res.status(status).json(payload);
}

module.exports = { admin, getAdmin, requireAuth, requireAdmin, json, extractBearerToken, getFirebaseInitError:()=>initError };
