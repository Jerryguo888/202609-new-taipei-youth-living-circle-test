/* ===== [AWS AI Bot 串接位置 1／2：服務開關與 API 網址] =====
   比賽前維持 enabled:false，不會呼叫模型或傳送對話。
   上線時建議流向：Vue -> API Gateway -> Lambda -> Amazon Bedrock。
   endpoint 填 API Gateway HTTPS 網址；驗證使用 Cognito JWT，
   不要把 AWS Access Key、Secret Key 或 Bedrock 憑證寫進這支前端程式。
   TODO 比賽當天：填入 endpoint，確認 Lambda 可用後才把 enabled 改成 true。 */
export const CHAT_SERVICE = Object.freeze({
  enabled: false,
  endpoint: "",
});

export function localChatReply(text) {
  const query = text.toLowerCase();
  if (query.includes("設點") || query.includes("站位")) {
    return "請進入「30 分鐘交通」，可直接搜尋站名，或從依行政區分組的下拉選單挑選任一站位，再執行可達動畫。";
  }
  if (query.includes("30") || query.includes("分鐘") || query.includes("交通")) {
    return "選擇站位與出發時間後，系統會把候車、站間行駛與轉乘成本放入交通圖，計算時間上限內可達的節點。";
  }
  if (query.includes("預算") || query.includes("成本")) {
    return "到「預算模擬」調整固定據點、巡迴駐點、行動車與人力，畫面會立即更新年度成本與覆蓋率。";
  }
  if (query.includes("托育") || query.includes("學校") || query.includes("停車")) {
    return "「資源缺口」會把未來需求與現有容量相比，分成穩定、觀察與高需求三個層級。";
  }
  return "我可以先幫你把問題拆成青年需求、資源缺口、交通覆蓋與年度成本四個面向。";
}

export async function getChatReply(text, context) {
  if (!CHAT_SERVICE.enabled || !CHAT_SERVICE.endpoint) return localChatReply(text);

  /* ===== [AWS AI Bot 串接位置 2／2：Lambda／Bedrock 請求格式] =====
     Lambda 建議接收：
     { message: string, context: { activeView: string, minuteLimit: number } }
     並回傳：{ reply: string } */
  const response = await fetch(CHAT_SERVICE.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      context: context,
    }),
  });
  if (!response.ok) throw new Error("聊天服務暫時無法使用");
  const payload = await response.json();
  return payload.reply || localChatReply(text);
}
