# 202609 黑客松｜新北青年生活圈

`new-taipei-youth-living-circle` 測試展示站。

功能包含青年人口 3D 地圖、2026 青年需求概念頁、公共資源缺口、30 分鐘公車可達分析、可點選的公車路線圖、官方捷運站線參考、預算情境模擬與尚未串模型的前端 Chatbot。

> 交通時間目前使用平均候車、站間行駛與轉乘成本估算；正式版需再接逐班時刻資料。

Chatbot 的 AWS 串接位置已在單頁 HTML 以「AWS AI Bot 串接位置 1／2、2／2」註解標記；正式架構預留 API Gateway → Lambda → Amazon Bedrock。
