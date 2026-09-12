export function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function parseHeadway(value, fallback) {
  const values = String(value || "").match(/\d+(?:\.\d+)?/g);
  if (!values || !values.length) return fallback;
  const nums = values.map(Number).filter(function (n) { return n > 0 && n <= 90; });
  if (!nums.length) return fallback;
  return nums.reduce(function (sum, n) { return sum + n; }, 0) / nums.length;
}

/* ===== [改版新增：官方捷運 CSV 解析用共用字串工具] ===== */
export function cleanOfficialField(value) {
  return String(value || "")
    .replace(/^'\{/, "")
    .replace(/\}'$/, "")
    .replace(/^'+|'+$/g, "")
    .trim();
}

export function localizedName(value) {
  return cleanOfficialField(value).split(",")[0].replace(/^'+|'+$/g, "").trim();
}

export function parseMetroStationSequence(value) {
  const result = [];
  const expression = /'(\d+),([^,']+),([^']+)'/g;
  let match;
  while ((match = expression.exec(String(value || ""))) !== null) {
    result.push({ sequence: Number(match[1]), id: match[2].trim(), name: match[3].replace(/站$/, "").trim() });
  }
  return result.sort(function (a, b) { return a.sequence - b.sequence; });
}

export function normalizeMetroStationName(value) {
  return localizedName(value)
    .replace(/^捷運/, "")
    .replace(/站$/, "")
    .replace(/台/g, "臺")
    .replace(/[／/]/g, "-")
    .replace(/[\s　]/g, "")
    .trim();
}

export function minutesOfDay(value) {
  const parts = String(value || "00:00").split(":").map(Number);
  return (Number.isFinite(parts[0]) ? parts[0] : 0) * 60 + (Number.isFinite(parts[1]) ? parts[1] : 0);
}

export function normalizeStopName(name) {
  return String(name || "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\s　]/g, "")
    .replace(/(往|向)[東西南北].*$/, "")
    .trim();
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
  });
}
