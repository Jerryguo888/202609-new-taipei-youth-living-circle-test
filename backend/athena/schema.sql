-- Glue / Athena 建表 DDL
--
-- 表名與欄位名必須跟 app/data/metrics.py 與 app/data/records.py 產生的 SQL 完全
-- 一致。不一致的後果是「查到 NULL」而不是報錯 —— 畫面上看起來像資料是空的，
-- 而不是設定錯了，很難查。scripts/sync_lake.py 用同一份欄位清單寫出 JSONL。
--
-- 執行前先把 __BUCKET__ 換成你的資料湖 bucket 名稱：
--   sed 's/__BUCKET__/ntpc-youth-datalake/g' backend/athena/schema.sql
--
-- **Athena 的 Query editor 一次只接受一個敘述**（整份貼進去會得到
-- "Only one sql statement is allowed"）。所以要嘛一段一段貼，要嘛用
-- backend/athena/apply_athena_schema.sh 透過 CLI 依序送出。
--
-- 第一次建立時 DROP TABLE 那幾行可以跳過（表還不存在）。重建時才需要，
-- 而且必須在 CREATE 之前先 DROP —— 改過欄位定義後直接 CREATE 會失敗。
--
-- 格式是 JSONL（一行一個 JSON 物件），不是一般的 JSON 陣列。用
-- org.openx.data.jsonserde.JsonSerDe 而不是 Hive 內建的，因為它支援
-- ignore.malformed.json —— 單一壞行不會讓整張表查不動。

CREATE DATABASE IF NOT EXISTS ntpc_youth;

-- ---------------------------------------------------------------------------
-- 指標表（query_metrics 用）
-- ---------------------------------------------------------------------------

-- `year` 在 Trino/Athena 是內建函式名，一定要用反引號包起來，否則建表就會失敗。
-- 後端產生的查詢一律用雙引號包識別字，所以查詢端沒這個問題。
DROP TABLE IF EXISTS ntpc_youth.population_youth;
CREATE EXTERNAL TABLE ntpc_youth.population_youth (
  district   string,
  `year`     string,
  age_20_29  int,
  age_30_34  int
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/population_youth/';

DROP TABLE IF EXISTS ntpc_youth.childcare_pressure;
CREATE EXTERNAL TABLE ntpc_youth.childcare_pressure (
  district          string,
  youth_per_center  double
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/childcare_pressure/';

-- ---------------------------------------------------------------------------
-- 名冊表（lookup_records 用；childcare_facilities 同時被 query_metrics 拿去
-- 做 COUNT(*)，所以這一張表兩個工具共用）
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS ntpc_youth.childcare_facilities;
CREATE EXTERNAL TABLE ntpc_youth.childcare_facilities (
  district  string,
  name      string,
  kind      string,
  operator  string,
  address   string,
  phone     string,
  capacity  string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/childcare_facilities/';

DROP TABLE IF EXISTS ntpc_youth.vaccine_clinics;
CREATE EXTERNAL TABLE ntpc_youth.vaccine_clinics (
  district     string,
  name         string,
  address      string,
  phone        string,
  clinic_type  string,
  reservation  string,
  self_paid    string,
  remark       string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/vaccine_clinics/';

DROP TABLE IF EXISTS ntpc_youth.vaccine_schedules;
CREATE EXTERNAL TABLE ntpc_youth.vaccine_schedules (
  district       string,
  vaccine_hours  string,
  bcg_hours      string,
  remark         string,
  updated        string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/vaccine_schedules/';

DROP TABLE IF EXISTS ntpc_youth.youbike_stations;
-- available/updated 是每小時抓一次的即時值（其他表是每月）。
-- updated 是來源自己的時戳，格式 20260913T014500，宣告成 string 而不是
-- timestamp —— Athena 的 timestamp 只吃 'YYYY-MM-DD HH:MM:SS'，餵它這種
-- 格式整欄會變 NULL。要當時間用就在查詢時 parse。
CREATE EXTERNAL TABLE ntpc_youth.youbike_stations (
  district    string,
  name        string,
  station_id  string,
  address     string,
  docks       int,
  available   int,
  updated     string,
  lat         double,
  lon         double
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://__BUCKET__/curated/youbike_stations/';

-- ---------------------------------------------------------------------------
-- 建完之後的自我檢查。每一條都應該回傳非零筆數；回傳 NULL 或 0 代表
-- JSONL 格式或欄位名對不上，不是資料真的空。
-- ---------------------------------------------------------------------------
-- SELECT COUNT(*) FROM ntpc_youth.population_youth;                 -- 期望 725（29 區 × 25 年）
-- SELECT COUNT(*) FROM ntpc_youth.childcare_pressure;               -- 期望 21
-- SELECT COUNT(*) FROM ntpc_youth.childcare_facilities;             -- 期望約 391
-- SELECT COUNT(*) FROM ntpc_youth.vaccine_clinics;                  -- 期望約 686
-- SELECT COUNT(*) FROM ntpc_youth.vaccine_schedules;                -- 期望 29
-- SELECT COUNT(*) FROM ntpc_youth.youbike_stations;                 -- 期望約 1606
--
-- 這一條模擬 query_metrics 實際會下的查詢，前三名應該是板橋、新莊、中和：
-- SELECT "district", SUM(age_20_29) AS value
-- FROM ntpc_youth.population_youth
-- WHERE "year" = '2024'
-- GROUP BY "district" ORDER BY value DESC LIMIT 3;
