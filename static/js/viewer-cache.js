// Small JSON records persist across reloads; GLB bytes identify changed models.
const STORAGE_KEY = "tailorrig:model-bounds:v1";
const MAX_RECORDS = 64;
const records = new Map();

function validBounds(bounds) {
  return [bounds?.min, bounds?.max].every((values) => (
    Array.isArray(values) && values.length === 3 && values.every(Number.isFinite)
  )) && bounds.min.every((value, index) => value <= bounds.max[index]);
}

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  if (Array.isArray(saved)) {
    saved.slice(-MAX_RECORDS).forEach(([url, record]) => {
      if (typeof url === "string" && typeof record?.fingerprint === "string" && validBounds(record)) {
        records.set(url, record);
      }
    });
  }
} catch {
  // Private browsing, disabled storage, or damaged JSON must not block loading.
}

export async function fingerprintModel(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function readModelBounds(url, fingerprint) {
  const record = records.get(url);
  return fingerprint && record?.fingerprint === fingerprint && validBounds(record)
    ? { min: [...record.min], max: [...record.max] }
    : null;
}

export function saveModelBounds(url, fingerprint, bounds) {
  if (!fingerprint || !validBounds(bounds)) return;
  records.delete(url);
  records.set(url, { fingerprint, min: [...bounds.min], max: [...bounds.max] });
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(records)));
  } catch {
    // The in-memory cache still works if persistent storage is unavailable.
  }
}
