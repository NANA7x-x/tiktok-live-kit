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

## 更新があったら
1. サーバーを止める（黒画面で Ctrl+C）
2. GitHub Desktop で **Fetch origin → Pull** を押す
3. サーバーを起動し直す
4. OBS のブラウザソースで「現在のページのキャッシュを更新」

※ サーバーは常に1つだけ起動すること（古いのが残っていると新しい信号が届かない）。
