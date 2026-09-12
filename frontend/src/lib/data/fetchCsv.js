import { fetchWithBrowserCache } from "./browserCache.js";

/* [改版保留：GitHub Pages／行動網路偶發中斷時自動重試 CSV。
   以 document.baseURI 解析同來源絕對網址，兼容本機伺服器與 GitHub Pages 子目錄。
   [Jerry 2026-09-13 新增：首次成功後寫入 Cache Storage；之後重整優先讀本機，
   離開網站滿 30 分鐘後由 browserCache.js 統一清除。] */
function waitForRetry(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

export async function fetchCsvResponse(path) {
  const url = new URL(path, document.baseURI).href;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithBrowserCache(url, { forceNetwork: attempt > 1 });
      if (response.ok) return response;
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await waitForRetry(attempt * 450);
  }
  const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || path);
  throw new Error("無法讀取 " + fileName + "（已自動重試 3 次；" + (lastError ? lastError.message : "未知錯誤") + "）");
}

export function dataLoadHint() {
  return location.protocol === "file:"
    ? "請以本機伺服器開啟網站。"
    : "請確認網路連線後重新整理頁面。";
}

export function parseCSV(text) {
  const matrix = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      matrix.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    matrix.push(row);
  }
  const headers = matrix.shift() || [];
  return matrix.filter(function (values) {
    return values.some(Boolean);
  }).map(function (values) {
    const item = {};
    headers.forEach(function (header, index) {
      item[header.replace(/^﻿/, "")] = values[index] || "";
    });
    return item;
  });
}

export async function loadPopulationCsv(path) {
  const response = await fetchCsvResponse(path);
  return parseCSV(await response.text());
}
