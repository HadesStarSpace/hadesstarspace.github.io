# 量子神器交换站（GitHub Pages 版）

一个完全跑在 GitHub 上的静态站点：手机/电脑打开网页 → 上传「文物容器」截图 → GitHub Actions 跑识别 → 结果写回 `data.json` → 全集团共享。

## 怎么用

1. 打开站点：`https://lindatou1314.github.io/qs-exchange/`
2. 第一次进去先点「切换/新建」，填你的游戏名（身份存在本机 localStorage）
3. 「上传入库」选一张文物容器整屏截图，等 30–60 秒，神器就会出现在「我的」里
4. 到「我的」把要拿去换的神器状态改成「可交换」；识别错了点「改」修正类型/等级/加成/模块 —— 手动填的模块会被记成模板，以后同类角标能自动认出来
5. 「交换市场」看谁有货，「需求匹配」看互相的匹配度，「意向箱」发/接交换意向，成交后记录自动转移所有权

## 结构

```
index.html        页面
app.js            全部前端逻辑（读写 GitHub API）
style.css         样式
data.json         全部共享数据（玩家/神器/需求/意向/识别模板/记录）
img/              神器底板与角标缩略图
inbox/            上传落点，Actions 处理完会删掉
scripts/recognize.py      OpenCV + tesseract 识别算法
scripts/process_inbox.py  把 inbox 里的截图识别后合并进 data.json
.github/workflows/recognize.yml  上传即触发的识别流水线
```

## 维护

- 数据出问题：`data.json` 每次写入都是一次提交，去仓库 Commits 里回滚即可
- 换令牌：新令牌直接替换 `app.js` 里 `GH.token` 那一行（建议令牌只给这个仓库 `Contents: Read and write`）
- 识别失败原因会写进 `data.json` 的 `notices`，页面「识别记录」里能看到；详细日志去 Actions → 识别入库
