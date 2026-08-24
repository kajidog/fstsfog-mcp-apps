# Datadog 権限とスコープ

このドキュメントは、`apps/mcp-datadog-logs` の各 MCP ツールが Datadog API を呼び出すために必要な Application Key 権限をまとめたものです。

最終確認日: 2026-08-24

## 前提

`apps/mcp-datadog-logs` は Datadog の Logs / Spans / Events / Metrics / Monitors API を直接呼び出します。認証には次の3つを使います。

- `DD_API_KEY`
- `DD_APP_KEY`
- `DD_SITE`

Japan site の場合は必ず `DD_SITE=ap1.datadoghq.com` を指定してください。`DD_SITE` を省略すると `datadoghq.com` に送信され、AP1 の key では 401 になります。

Application Key を scoped key として作る場合は、下記の権限を付けてください。scoped key にしない場合、Application Key は作成ユーザーの権限を引き継ぎます。

## 現在の最小権限

ログ系ツールだけを使う場合の最小権限は次の2つです。

| 権限 | 用途 |
|---|---|
| `logs_read_data` | ログデータの読み取り |
| `logs_read_index_data` | ログインデックスデータの読み取り |

Datadog の権限ドキュメントでは、ログデータを読むには `logs_read_data` と Logs Read Index Data の両方が必要とされています。

trace / イベント / メトリクス / モニター系ツールも使う場合は、追加で次の権限が必要です。

| 権限 | 用途 |
|---|---|
| `apm_read` | APM スパンの読み取り(`datadog_get_trace`) |
| `events_read` | イベントの読み取り(`datadog_search_events`、調査ツールのイベント重畳) |
| `timeseries_query` | メトリクス timeseries の読み取り(`datadog_query_metrics`、調査ツールの `metricsQueries`) |
| `monitors_read` | モニター定義と状態の読み取り(`datadog_list_monitors`) |

調査ツール(`datadog_run_investigation` / `datadog_investigate_logs` / `_run_investigation`)は `events_read` / `timeseries_query` が無くても失敗しません。該当データの取得だけをスキップし、結果の `notices` にその旨を記録します(graceful degradation)。

不要な権限:

- `logs_write_*`
- `logs_delete_data`
- `logs_modify_indexes`
- `mcp_read`
- `mcp_write`

`mcp_read` / `mcp_write` は Datadog 公式 MCP Server 用の権限です。このリポジトリの `apps/mcp-datadog-logs` は Datadog Logs API を直接叩く実装なので、通常は不要です。

## ツール別の必要権限

| MCP tool | Datadog API | 操作 | 必要権限 | 備考 |
|---|---|---|---|---|
| `datadog_search_logs` | `v2.LogsApi.listLogs` | ログ検索 | `logs_read_data`, `logs_read_index_data` | model-facing tool |
| `datadog_aggregate_logs` | `v2.LogsApi.aggregateLogs` | ログ集計 | `logs_read_data`, `logs_read_index_data` | facet 集計と timeseries 集計 |
| `datadog_get_trace` | `v2.SpansApi.listSpans` | trace_id からスパン検索 | `apm_read` | model-facing tool。403 時は `apm_read` を案内 |
| `datadog_search_events` | `v2.EventsApi.searchEvents` | イベント検索(deployment/monitor 等) | `events_read` | model-facing tool。403 時は `events_read` を案内 |
| `datadog_query_metrics` | `v1.MetricsApi.queryMetrics` | メトリクス timeseries クエリ | `timeseries_query` | model-facing tool。403 時は `timeseries_query` を案内 |
| `datadog_list_monitors` | `v1.MonitorsApi.searchMonitors` | モニターの一覧/状態確認(state / tag / name / 生クエリで絞り込み) | `monitors_read` | model-facing tool。403 時は `monitors_read` を案内。`DD_LOGS_INDEXES` は適用されない(モニターにインデックスの概念が無いため) |
| `datadog_run_investigation` | `v2.LogsApi.listLogs`, `v2.LogsApi.aggregateLogs` (+ `v2.EventsApi.searchEvents`, `v1.MetricsApi.queryMetrics`) | UI を開かない調査(結果はサーバー側セッションに保存) | `logs_read_data`, `logs_read_index_data`(任意: `events_read`, `timeseries_query`) | model-facing tool。モデルには要約のみ返す。イベント/メトリクスは権限が無ければスキップして `notices` に記録 |
| `datadog_get_session_logs` | なし | 保存済みセッションの行を絞り込み/1件の raw log を取得 | なし | model-facing tool。Datadog へ再問い合わせしない(調査時に取得済みの行だけを読む) |
| `datadog_export_report` | なし | 保存済み調査結果を HTML / CSV / JSON でファイル出力 | なし | model-facing tool。`getDatadogClient().site` を表示用に読むが API 呼び出しはしない |
| `datadog_investigate_logs` | `v2.LogsApi.listLogs`, `v2.LogsApi.aggregateLogs` (+ `v2.EventsApi.searchEvents`, `v1.MetricsApi.queryMetrics`) | 調査 UI 用の初回検索/集計 | `logs_read_data`, `logs_read_index_data`(任意: `events_read`, `timeseries_query`) | model-facing tool。UI を開く。`viewUUID` 指定時は API 呼び出しなしで保存済みセッションを表示 |
| `_get_view_state` | なし | 保存済み view state の取得 | なし | app-only tool。Datadog へ再問い合わせしない |
| `_run_investigation` | `v2.LogsApi.listLogs`, `v2.LogsApi.aggregateLogs` (+ `v2.EventsApi.searchEvents`, `v1.MetricsApi.queryMetrics`) | UI からの再検索/集計 | `logs_read_data`, `logs_read_index_data`(任意: `events_read`, `timeseries_query`) | app-only tool |
| `_get_log_detail` | なし | 保存済み raw log の取得 | なし | app-only tool。Datadog へ再問い合わせしない |
| `_export_report` | なし | 保存済み調査結果の HTML 出力 | なし | app-only tool。`getDatadogClient().site` を表示用に読むが API 呼び出しはしない |

## 新しいツールを追加するとき

Datadog API を呼ぶツールを追加したら、この表に1行追加してください。

| MCP tool | Datadog API | 操作 | 必要権限 | 備考 |
|---|---|---|---|---|
| `datadog_example` | `v2.ExampleApi.exampleMethod` | 何をするか | `example_read` | read/write、UI-only など |

確認手順:

1. 実装で呼ぶ Datadog SDK class/method を特定する。
2. Datadog の API docs または Role Permissions docs で必要権限を確認する。
3. read-only で足りるか、write 権限が必要かを判断する。
4. scoped application key で動くかを Inspector で確認する。
5. このファイルの「ツール別の必要権限」を更新する。

## 動作確認コマンド

```bash
DD_SITE=ap1.datadoghq.com \
DD_API_KEY=... \
DD_APP_KEY=... \
npx @modelcontextprotocol/inspector node apps/mcp-datadog-logs/dist/index.js
```

新しい key は Datadog 側で反映に数秒かかることがあります。作成直後に 401/403 が出る場合は、少し待って再試行してください。

## エラーの見方

| エラー | よくある原因 |
|---|---|
| 401 Unauthorized | `DD_API_KEY` が違う、`DD_SITE` が違う、`DD_APP_KEY` が同じ org/site の key ではない |
| 403 Forbidden | Application Key の権限不足、作成ユーザーの権限不足、scoped key の scope 不足 |
| 429 Too Many Requests | Datadog API の rate limit。時間範囲を狭める、連続 refresh を避ける、複数 MCP client から同時に叩かない、rate-limit window の reset を待つ |
| 400 Bad Request | Datadog log query や time range の形式が不正 |

## 参考リンク

- Datadog API and Application Keys: https://docs.datadoghq.com/account_management/api-app-keys/
- Datadog Role Permissions: https://docs.datadoghq.com/ja/account_management/rbac/permissions/
