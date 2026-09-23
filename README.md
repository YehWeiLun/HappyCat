# HappyCat · 小貓散步

在 MapLibre 地圖上帶一隻 3D 小貓散步。純靜態 HTML，Three.js 與 MapLibre GL JS 由 CDN 載入，可直接用 GitHub Pages 發布。

## 操作

| 桌機 | 手機 | 功能 |
| --- | --- | --- |
| W A S D／方向鍵 | 左下搖桿 | 移動（依鏡頭方向） |
| R | 跑步 按鈕 | 切換走路／跑步 |
| Space | 跳 按鈕 | 跳躍 |
| Ctrl | 趴下 按鈕 | 趴下休息／起身 |
| Tab | 視角 按鈕 | 第一／第三人稱 |
| 滑鼠移動（點畫面鎖定，Esc 釋放） | 單指拖曳 | 轉向與仰角 |
| 滾輪 | 雙指縮放 | 第三人稱鏡頭遠近 |

小貓的位置、朝向、走／跑、是否趴著、視角與鏡頭角度會存在瀏覽器的 localStorage，下次開啟會回到原位；「回到起點」可重設。

## 本機預覽

GLB 需透過 HTTP 載入，不能直接雙擊 HTML：

```sh
npx serve .
```

## 素材與授權

- `cat_v01.glb`：本專案自製的低面數貓咪模型與九段動畫。
- 底圖：[OpenFreeMap](https://openfreemap.org/) liberty 樣式，資料 © OpenStreetMap contributors。
