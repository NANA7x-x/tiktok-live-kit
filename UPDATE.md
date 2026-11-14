# 更新のしかた（本人用メモ）

このリポジトリがキットの正本。Claude がここに新しい版を push する。

## 初回だけ
1. GitHub Desktop でこのリポジトリを Clone する
2. クローンしたフォルダに、前のフォルダから `discord_webhook.txt` をコピーする
3. フォルダで cmd を開いて `npm install`

## 起動
```
node server.js @7x_x7x_x7x_x7
```
リモコン: http://localhost:21213/remote.html

## v4 に上げるときだけ（1回）
- OBSのブラウザソースを README の「OBSに入れるもの」の形にする（overlay.html／front.html／アバター／back.html）
- 前の版の配置・テーマ・特典ログ（layout.json など）は使わなくなります。消してもOK

## 更新があったら（自動化済み）
1. GitHub Desktop で **Fetch origin → Pull** を押すだけ

- `server.js` が更新された場合、起動中のサーバーが自動で再起動する（新しい黒画面が開く）。
- 画面側のファイル（overlay.html）が更新された場合、OBS のオーバーレイが自動で読み直すので、OBS の「キャッシュを更新」も不要。
- リモコンだけは、更新後にブラウザで F5 を1回押して。

※ サーバーは常に1つだけ起動すること（古いのが残っていると新しい信号が届かない）。
