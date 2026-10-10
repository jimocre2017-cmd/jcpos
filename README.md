# JC POS（Jimo Cafe POS アプリ版）

Jimo Cafe の注文・会計POSのアプリ版（PWA・オフライン対応）。
公開URL：[https://jimocre2017-cmd.github.io/jcpos/](https://jimocre2017-cmd.github.io/jcpos/)

- サーバー：Google Apps Script（JC_POSシステムのアプリ専用デプロイ）
- 端末の設定は、POSのウェブアプリURLに `?mode=app` を付けて開き、管理者暗証番号で表示されるQR／リンクから行う
- 画面を更新したら `sw.js` の `VERSION` を上げる（例：jcpos-v2 → jcpos-v3）。端末は起動時・画面に戻った時・15分ごとに確認し、操作が空いたタイミングで自動更新する（再インストール不要）
