# セキュリティ TODO(未実装)

このファイルは「合意済みだが、まだ実装していない」セキュリティ作業の記録です。
**S1〜S5 はいずれも現時点でコードに入っていません。** 実装済みの対策を説明する
ドキュメントではなく、次に手を入れるときの計画として読んでください。

最終確認日: 2026-08-27

## 現状の位置づけ

先に前提を書いておきます。このリポジトリの **出力側のハードニングは既にかなり厚い** です。

- **HTML レポート**: `report/generate.ts` は動的な値をすべて `escapeHtml` に通しています。
  `report/styles.ts` / `report/script.ts` は静的な文字列で、ユーザーデータを一切埋め込みません。
- **CSV エクスポート**: `report/export-data.ts` の `csvField()` が RFC 4180 のクォートに加えて
  `=` `+` `-` `@` `\t` `\r` 始まりのフィールドを先頭アポストロフィで無害化しています
  (数式インジェクション / CWE-1236)。
- **セッション永続化**: `tools/investigate/persistence.ts` は読み込み側 (`loadSession`) と
  書き込み側 (`persistSession`) の**両方**で viewUUID を `/^[0-9a-fA-F-]{36}\.json$/` に
  照合し、`sessionDir` 配下から外れるパスを作らせません。

不足しているのは **非対称性** です。容器(HTML / CSV / ファイルパス)は固めてあるのに、
そこに入る**中身(ログ本文)は一度も検査されないまま**通り抜けます。
つまり以下は「放置されたコードベース」の話ではなく、**レイヤーが一枚足りない**という話です。

## 一覧

| ID | 課題 | 場所 | 決定 |
|---|---|---|---|
| S1 | ログ本文のマスキングが存在しない | `app-tools.ts` / `get-session-logs-tool.ts` / `persistence.ts` / `export-report.ts` | 既定 ON・上書き可能。`normalize.ts` とエクスポート経路の2箇所に集約 |
| S2 | セッションファイルが 0644 / ディレクトリが 0755 | `persistence.ts` | `mkdirSync(dir, { mode: 0o700 })` / `writeFileSync(path, json, { mode: 0o600 })` |
| S3 | MCP Apps リソースの CSP が空オブジェクト | `tools/investigate/resource.ts` | 実際に必要なディレクティブを列挙する |
| S4 | `DD_SITE` が未検証のまま送信先ホストになる | `config.ts` → `datadog/client.ts` | 既知の Datadog site の形にバリデーションする |
| S5 | インメモリセッションに TTL もバイト上限も無い | `runtime.ts` / `session-ops.ts` | ディスク側と対称にする |

---

## S1. ログ本文のマスキングが無い

**現状**: リポジトリ全体で `redact` / `mask` / `sanitize` の実装は **0件** です
(唯一の一致は `search-logs.test.ts` のコメント)。Datadog から取得した生ログは、
正規化 (`datadog/normalize.ts`) で長さ・件数を切り詰められるだけで、
**内容は一度も検査されません**。

**なぜ重要か — 生ログが出ていく経路が3つある**:

1. **LLM のコンテキスト**
   `datadog_get_session_logs` の detail モードは生ログの JSON を最大
   `MAX_DETAIL_CHARS = 8000` 文字までそのままモデルに返します
   (`tools/investigate/get-session-logs-tool.ts`)。app-only の `_get_log_detail` は
   `jsonResult(raw)` で生イベント全体を UI に返します (`tools/investigate/app-tools.ts`)。
   ログに Authorization ヘッダやトークンが載っていれば、そのまま外部モデルに渡ります。
2. **平文のセッションファイル**
   `persistSession()` は `rawLogs` を含む JSON を `~/.cache/mcp-datadog-logs/sessions/`
   配下に平文で書き、**7日間**保持します (`SESSION_TTL_MS`)。
3. **エクスポートされたレポート — これが一番重い**
   HTML / CSV / JSON レポートは `MCP_DATADOG_EXPORT_DIR`(既定 `~/Downloads`)に書かれ、
   **人に共有されることを目的にしています**。マスキングが無いということは、
   「共有用に作った成果物」がそのまま資格情報の配布物になり得るということです。

**決定 — 既定 ON、上書き可能**:

- Bearer トークン / JWT / 汎用 API キー / AWS アクセスキー / メールアドレス /
  クレジットカード番号 / 秘密鍵ブロック の組み込みパターンを **既定で有効**にする。
- `MCP_DATADOG_REDACT=false` で無効化できる(ローカルの信頼された環境向け)。
- `MCP_DATADOG_REDACT_PATTERNS` で追加パターンを与えられる。
- 適用箇所は**2つの境界に集約する**: `datadog/normalize.ts`(取り込み時)と
  エクスポート経路 (`tools/investigate/export-report.ts` / `report/`)。
  呼び出し側ごとに散らすと、必ずどれかの経路が漏れます。

**注意点**: `analysis/patterns.ts` のテンプレート化はマスク後の文字列に対して走るため、
マスキング導入でクラスタリング結果が変わります。既存テストの期待値に影響します。

---

## S2. セッションファイルのパーミッション

**現状**: `persistSession()` は

```ts
mkdirSync(sessionDir, { recursive: true })   // mode 指定なし → 0755
writeFileSync(tmpPath, json, 'utf-8')        // mode 指定なし → 0644
renameSync(tmpPath, path)
```

と書いています。`mode` を渡していないので、umask 次第で
**ディレクトリ 0755 / ファイル 0644** になります。

**なぜ重要か**: 共有マシン(踏み台サーバー、共用開発機、CI ランナー)では、
**同居する他ユーザーが本番ログの中身をそのまま読めます**。S1 が未実装である以上、
その中身は無加工の生ログです。パーミッションと S1 は互いの前提になっているので、
片方だけ入れても穴は残ります。

**決定**:

- `mkdirSync(sessionDir, { recursive: true, mode: 0o700 })`
- `writeFileSync(path, json, { encoding: 'utf-8', mode: 0o600 })`
- **`.tmp` ファイルにも同じ mode を付ける**。`renameSync` はパーミッションを引き継ぐので、
  tmp 側を 0644 のままにすると本命ファイルも 0644 になります。
- 既存ファイルには `writeFileSync` の `mode` が効かないため、
  移行時の `chmod` を行うか、少なくともその制約を書き残すこと。

---

## S3. MCP Apps リソースの CSP が空

**現状**: `tools/investigate/resource.ts` は

```ts
_meta: { ui: { csp: {} } }
```

を返しています。ディレクティブが1つも宣言されていないので、
ホスト側のサンドボックス既定に完全に委ねている状態です。

**なぜ重要か**: 埋め込み UI は `mcp-app.html` 単体で完結しており、外部リソースを
必要としません。にもかかわらず何も宣言していないため、
「このアプリは外部通信をしない」という意図がホストに伝わりません。
将来 UI に外部参照が混入しても、誰も気付けません。

**決定**: 実際に必要なディレクティブだけを列挙する。
現状の単一ファイル構成なら、スクリプト・スタイルはインライン、
接続先は MCP ホストとの橋渡しのみ、画像は `data:` のみ、というかなり狭い集合になるはずです。
実装時は Inspector と実ホストの両方で、宣言が UI を壊さないことを確認すること。

---

## S4. `DD_SITE` が未検証

**現状**: `getDatadogConfig()` は

```ts
site: env.DD_SITE?.trim() || 'datadoghq.com'
```

と、任意の文字列をそのまま通します。これが `datadog/client.ts` で

```ts
configuration.setServerVariables({ site: config.site })
```

に渡り、**API リクエストの宛先ホストそのもの**になります。

**なぜ重要か**: `DD_SITE` は設定ミスでも改竄でも同じ結果を生みます。
不正な値が入った時点で、`DD_API_KEY` と `DD_APP_KEY` の**両方**が
攻撃者の指定したホストに送信されます。MCP サーバーの設定ファイルは
エディタの設定やドットファイルとして共有・同期されることが多く、
「設定文字列を1つ差し替えるだけ」の攻撃面としては安すぎます。

**決定**: 既知の Datadog site の形(`datadoghq.com` / `datadoghq.eu` /
`us3` `us5` `ap1` `ap2` などのリージョン接頭辞付き / `ddog-gov.com`)に対して
ホスト形状を検証し、外れた場合は**起動時ではなくツール呼び出し時に**
既存のエラー方針に沿って明示的に失敗させる。ワイルドカードでの緩い一致
(`*.datadoghq.com` を丸ごと許可するなど)は避けること。

---

## S5. インメモリセッションに TTL もバイト上限も無い

**現状**: ディスク側とメモリ側で保護が非対称です。

| | 件数上限 | TTL | バイト上限 |
|---|---|---|---|
| ディスク (`persistence.ts`) | 50 (`MAX_PERSISTED_SESSIONS`) | 7日 (`SESSION_TTL_MS`) | 15 MB (`MAX_SESSION_FILE_BYTES`) |
| メモリ (`runtime.ts`) | 50 (`MAX_SESSIONS`) | **なし** | **なし** |

1セッションは最大 500 行 (`HARD_MAX_ROWS`) の `rows` に加えて、
`rawById` に生ログを丸ごと保持します。さらに `cursor` による load-more は
**既存セッションに行を追記していく**ため (`session-ops.ts`)、
LRU の1エントリが上限なく育ちます。

**なぜ重要か**: stdio の MCP サーバーはホストのセッションと同じだけ生き続けます。
長時間の調査で load-more を繰り返すと、50 エントリすべてが上限なく膨らみ、
古いセッションは触られなくても解放されません。加えて、
生ログがプロセスメモリに無期限に残り続けること自体が S1 の被害範囲を広げます。

**決定**: メモリ側をディスク側と対称にする。

- `setSession()` に TTL を持たせ、`getSession()` で期限切れを退避する
  (ディスクの 7日と揃える。ディスクに残っていれば `loadSession` が復元する)。
- セッションあたりの概算バイト数に上限を設け、超過分は `rawById` から先に落とす
  (`result.rows` より生ログの方が大きく、失っても UI/レポートは成立するため)。
- 上限はディスク側の定数を単一のソースとして共有し、二重管理にしないこと。

---

## 既知の非セキュリティ課題

実装中に見つけたが、意図的に手を付けなかったものです。

### `bg-status-other` に対応する色トークンが無い

`packages/investigator-ui/src/components/FacetSidebar.tsx` は、
既知のステータス以外のファセット値に対して Tailwind クラス `bg-status-other` へ
フォールバックします。

```tsx
className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[v.value] ?? 'bg-status-other')}
```

一方 `packages/investigator-ui/src/styles.css` の `@theme` ブロックが登録しているのは
`--color-status-error` / `-warn` / `-info` / `-debug` の4つだけで、
**`--color-status-other` はありません**(生の `--status-other: #898781` は定義済みですが、
`@theme` に登録されていないため Tailwind のユーティリティが生成されません)。
結果として、そのドットは背景色なしで描画されます。

修正は `@theme` に `--color-status-other: var(--status-other);` を1行足すだけです。

### `report/generate.ts` のヘッダーが `formatTs` を無防備に呼ぶ

`generate.ts` の55〜57行目:

```ts
const { timeZone, format: formatTs } = timestampFormatter(options.timeZone ?? 'UTC')
const generatedAt = `${formatTs(Date.now())} (${timeZone})`
const range = `${formatTs(result.resolvedRange.fromMs)} → ${formatTs(result.resolvedRange.toMs)} (${timeZone})`
```

`resolvedRange` に非有限値(または Date の範囲外の値)が入っていると `Intl` が throw し、
**エクスポート全体が失敗します**。後から追加した比較セクションの `comparisonTime()` は

```ts
return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? formatTs(ms) : '(unknown)'
```

とガードしていますが、既存のヘッダー行にはこのガードがありません。
現実には `resolveRange()` が範囲を検証してから `resolvedRange` に入るため到達しにくく、
今回は比較セクション側だけを守って据え置きました。
直すなら `comparisonTime()` をヘッダーにも使い回すのが素直です。
