## 这个 PR 改了什么

<!-- 一两句话说清楚：改了哪块、为什么改。 -->

## 提交前自查

- [ ] 改过 `src/client.js` 的话，跑过 `node scripts/build-client.mjs`，并把 `lib/client.js` 一起提交了（CI 会校验这两个文件是否对得上；`lib/client.js` 是生成物，不要手改）
- [ ] `node scripts/selftest.mjs` 通过（22 组，exit 0）
- [ ] `node scripts/host-smoke.mjs` 通过（19 组，exit 0）
- [ ] 用户看得见的变化，写进了 `CHANGELOG.md`
- [ ] 没有把本机的路径、日志、数据目录（`~/.dsh/dsh-fuse`）一起提交进来

## 影响面

- [ ] 只在浏览器半边（`src/client.js`）
- [ ] 只在宿主半边（`src/index.js` / `src/fuse.js` / `src/ledger.js`）
- [ ] 动了配置项或流水格式 —— 说明老配置 / 老数据怎么兼容：
