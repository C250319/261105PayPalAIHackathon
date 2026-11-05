# STEPS — 依頼者が最後にやること

> Final manual steps for the project owner (in Japanese): merge the PR, upload the video to YouTube, and submit on Devpost.

上から順に進めれば提出まで終わります。締切は **2026年11月12日 12:00（米国太平洋時間）＝ 11月12日 20:00 UTC ＝ 日本時間 11月13日（金）午前5:00** です。前日までに済ませるのが安全です。

---

## 0. 足りなかったもの

**ありません。** 用意された環境変数（`PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET`、`PAYPAL_SANDBOX_BUYER_EMAIL`、`PAYPAL_SANDBOX_BUYER_PASSWORD`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`）はすべて入っていて、PayPal サンドボックスのアクセストークン取得、Cloudflare への公開、Workers AI の利用まで確認できました。

参考（作業中に変えたこと・しなかったこと）：

- サンドボックス買い手アカウントの**表示言語を English に変更**しました（PayPal の画面を審査員と動画向けに英語にするため）。戻す場合は https://www.sandbox.paypal.com に買い手でログイン → 右上の **Settings（設定）** → **Account** → **Language** で「日本語」を選びます。
- PayPal の **Webhook は登録していません**（このセッションでは外部設定の変更が許可されなかったため）。なくても作品は動きます。任意で有効にしたい場合は README の「How PayPal is used」の最後を参照してください。
- 公開済みのアプリ：**https://allowance.261105cn.workers.dev**（このセッションから公開済み。依頼者が公開作業をする必要はありません）

---

## 1. GitHub：プルリクエストをマージする

1. ブラウザで GitHub にログインし、このリポジトリ（`261105PayPalAIHackathon`）を開きます。
2. 上部の **Pull requests** タブを開き、タイトルが **「Allowance: PayPal-hold-bounded AI shopping agent (PayPal AI Hackathon submission)」** のプルリクエストをクリックします。
3. 下までスクロールし、緑の **Merge pull request** ボタン → **Confirm merge** を押します。
4. （任意）表示される **Delete branch** を押して作業用ブランチを消します。
5. リポジトリのトップ（**Code** タブ）に戻り、右側の **About** 欄に **MIT license** と表示されていることを確認します。
6. About 欄の右の **歯車アイコン** を押し、次を入れて **Save changes**：
   - **Description**：`Give your AI agent an allowance, not your wallet — PayPal authorization holds + Workers AI agent + AG Grid ledger`
   - **Website**：`https://allowance.261105cn.workers.dev`
   - **Topics**：`paypal`, `ai-agents`, `agentic-commerce`, `cloudflare-workers`, `workers-ai`, `ag-grid`, `hackathon`

> リポジトリは**公開（Public）**のままにしてください（審査の条件です）。現在も Public です。

---

## 2. 動画をダウンロードして YouTube に「公開」でアップロードする

### 2-1. 動画ファイルを手元に保存する

1. GitHub のリポジトリで **docs** フォルダ → **demo.mp4** を開きます。
2. 右上の **ダウンロードアイコン（Download raw file）** を押して保存します（約11MB、2分20秒）。
3. 同じ **docs** フォルダの **demo.srt**（英語字幕）も同じように保存しておくと、YouTube の字幕に使えます（任意）。

### 2-2. YouTube にアップロードする

1. https://studio.youtube.com を開き、提出に使う Google アカウントでログインします（初めての場合はチャンネルを作成）。
2. 右上の **作成（Create）** → **動画をアップロード（Upload videos）** → **ファイルを選択（Select files）** で `demo.mp4` を選びます。
3. **詳細（Details）** 画面で次を入力します。
   - **タイトル（Title）**：`Allowance — Give your AI agent an allowance, not your wallet (PayPal AI Hackathon)`
   - **説明（Description）**：
     ```
     Allowance lets an AI agent shop for you while a PayPal authorization hold caps every cent it can spend. AI drafts a spending mandate from your errand, you approve it once with PayPal (JS SDK v6, intent AUTHORIZE), and every agent purchase is a partial capture checked by a code firewall and an AI auditor (Cloudflare Workers AI). The AG Grid ledger shows every attempt; unused money is released with a void. PayPal sandbox only.
     Live demo: https://allowance.261105cn.workers.dev
     ```
   - **視聴者（Audience）**：**いいえ、子ども向けではありません（No, it's not made for kids）** を選択。
4. **次へ（Next）** を押します。**動画の要素（Video elements）** 画面で、字幕を付ける場合は **字幕を追加（Add subtitles）** → **追加（Add）** → **ファイルをアップロード（Upload file）** → **タイミングあり（With timing）** → `demo.srt` を選び **完了（Done）**。（映像に字幕は焼き込み済みなので、省略しても構いません。）
5. **次へ（Next）** → **チェック（Checks）** 画面で **次へ（Next）**。
6. **公開設定（Visibility）** で **公開（Public）** を選び、**公開（Publish）** を押します。※「限定公開」「非公開」は不可です（審査の条件）。
7. 表示される **動画リンク（Video link）**（`https://youtu.be/...`）をコピーしておきます（手順3で使います）。

---

## 3. Devpost：登録 → ハッカソンに参加 → 提出

### 3-1. アカウント作成とハッカソンへの参加

1. https://devpost.com を開き、右上の **Sign up**（アカウントがあれば **Log in**）で登録します（メール、GitHub、Google など）。
2. https://paypalaihackathon.devpost.com/ を開き、**Join hackathon** を押します。
3. 表示される質問（居住国、年齢要件など）に答え、公式ルール（Official Rules）への同意にチェックして参加を完了します。

### 3-2. 提出（プロジェクト）を作る

1. ハッカソンのページで **Enter a submission**（または **Start project / Create project**）を押します。
2. 各欄に、リポジトリの **SUBMISSION.md** から次のように貼り付けます（GitHub で SUBMISSION.md を開き、該当する節の本文をコピー）。

| Devpost の欄 | SUBMISSION.md のどこを貼るか |
| --- | --- |
| **Project name** | 「Project name」の `Allowance` |
| **Elevator pitch** | 「Elevator pitch」の1文 |
| **About the project**（Project story。見出し入りの1つの欄） | 欄にあらかじめある見出しの下に、同じ名前の節の本文を貼る：**Inspiration**／**What it does**／**How we built it**／**Challenges we ran into**／**Accomplishments that we're proud of**／**What we learned**／**What's next for Allowance**（欄が見出しごとに分かれている場合は、同じ名前の欄に貼る） |
| **Built with** | 「Built with」のカンマ区切りの語を1つずつ入力（入力するたびに Enter） |
| **Try it out**（リンク） | `https://allowance.261105cn.workers.dev` と、GitHub リポジトリのURL（ブラウザのアドレスバーからコピー） |
| **Image gallery** | `docs/gallery-1-workspace.png` → `gallery-2-paypal-approval.png` → `gallery-3-ledger.png` → `gallery-4-mandates-and-store.png` → `gallery-5-landing.png` の順にアップロード（GitHub で各画像を開き、ダウンロードアイコンで保存してから） |
| **Video demo link** | 手順2でコピーした YouTube のリンク |

3. 次のページ（**Additional info** など、ハッカソン独自の質問）では、次のように答えます。

| 質問の例 | 答え方 |
| --- | --- |
| Testing instructions / How can judges access or test your project? | SUBMISSION.md の **For judges** の節をすべて貼る（サンドボックス買い手のメールとパスワード入り。本物のお金は動きません） |
| URL to your code repository | GitHub リポジトリのURL |
| Hosted demo URL / Website | `https://allowance.261105cn.workers.dev` |
| Which AI tools / models did you use and how? | SUBMISSION.md の **Tools used (AI and sponsor tools)** の節 |
| Which PayPal APIs / products did you use? | 同じ節の「PayPal developer platform」の行（JS SDK v6、Orders v2、Payments v2） |
| Which sponsor tools did you use? | **AG Grid**（AG Grid Community と AG Charts Community） |
| 応募する賞を選ぶ欄（例：「Which prizes / challenges are you submitting to?」「Opt in to sponsor prizes」） | **Best Use of AG Grid** にチェック。ほかに選べるものがあれば **Best Use of Agentic Commerce**、**Best Use of PayPal + AI** などもチェック（全体の順位の賞は自動で対象） |
| Was this project started before the hackathon? など | 「いいえ（ハッカソン期間中の2026年11月に新しく作った）」 |

4. チームメンバーの欄があれば、依頼者本人だけにします。
5. 最後のページで内容を確認し、**Submit project**（または **Submit**）を押します。ステータスが **Submitted** になれば完了です。締切までは **Edit project** で修正できます。

---

## 4. 提出後（審査期間：2026年12月1日〜12月15日）

- **何もしなくても動き続けます。** 次のことだけは避けてください：Cloudflare の Worker（`allowance`）の削除、workers.dev のサブドメイン変更、PayPal サンドボックスアプリの Client Secret の再発行（行うとアプリが PayPal に接続できなくなります）、サンドボックス買い手アカウントの削除やパスワード変更。
- AI の無料枠（1日1万ニューロン）を審査員が使い切った日は、画面上部に案内が出て「ルールのみモード」で動き続け、翌日 00:00 UTC（日本時間 9:00）に戻ります。
- もし Client Secret を再発行した場合は、このリポジトリで `npx wrangler secret put PAYPAL_CLIENT_SECRET` を実行して新しい値を入れ直してください（README の「Run it yourself」参照）。
