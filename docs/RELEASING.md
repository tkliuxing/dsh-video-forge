# 发版流程

> 面向维护者。使用者只需要 [README.md](../README.md) 里的安装命令。
>
> **硬性规则：发版只走 GitHub Actions + npm trusted publishing（OIDC），不在本地
> `npm publish`。** 本地发布需要 2FA OTP、拿不到 provenance，而且产物与 CI 走的是两条
> 不同的路径。唯一的例外是下面 §1 的首次引导，因为 npm 只允许给**已存在**的包配置
> trusted publisher，第一次发布没有 OIDC 可用。

## 0. 前置状态（一次性配置）

| 事项 | 值 |
|---|---|
| npm 包名 | `dsh-video-forge`（2026-10-13 实测未被占用） |
| GitHub 仓库 | `tkliuxing/dsh-video-forge`（本地目录仍叫 `dsh-video-studio`，见 `DESIGN.md` 开头说明） |
| 工作流文件 | `.github/workflows/publish.yml` |
| GitHub environment | `publishing` |
| 默认 dist-tag | `latest` |

npm 侧要求 `npm >= 11.5.1`，工作流里已用 `npm install -g npm@latest` 兜底。

## 1. 首次引导（只做一次）

npm 不能给尚不存在的包配置 trusted publisher，所以 `0.1.0` 只能用一次性的 token 发。
建议走 CI 而不是本地，这样至少产物与后续版本同一条构建链路。

1. npm → **Access Tokens** → 生成一个 **Classic / Automation** token（Automation 类型
   才会绕过 2FA；新包无法用 granular token 限定到包，因为它还不存在）。
2. GitHub 仓库 → **Settings → Secrets and variables → Actions** → 新建 `NPM_TOKEN`。
3. 临时加一个工作流 `.github/workflows/publish-bootstrap.yml`，手动触发一次：

   ```yaml
   name: publish-bootstrap
   on: workflow_dispatch
   permissions:
     contents: read
     id-token: write      # 让 npm 尽量也能签 provenance
   jobs:
     publish:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: pnpm/action-setup@v4
         - uses: actions/setup-node@v7
           with:
             node-version: '24'
             registry-url: 'https://registry.npmjs.org'
             cache: pnpm
         - run: npm install -g npm@latest
         - run: pnpm install --frozen-lockfile
         - run: npm publish --tag latest --provenance
           env:
             NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```

   若 npm 拒绝 `--provenance`（token 渠道的签名能力有变化），去掉该参数重跑即可：版本
   号还能用，只是这一版没有 attestation。

4. 发布成功后，在 npm 包页面 → **Settings → Trusted publishing** 配置：
   - Publisher: **GitHub Actions**
   - Repository: `tkliuxing/dsh-video-forge`
   - Workflow filename: `publish.yml`
   - Environment: `publishing`（工作流引用了这个 environment，npm 侧必须填同一个名字）

   > 两条 npm 侧的规则会**静默打死发布**（2026-11-19 在 `0.2.0` 上撞到，别再踩）：
   > - **配置 2 天内必须完成一次成功发布**才算验证通过；超期后配置**过期、不可使用也不可编辑**，只能删除重建。`0.1.0` 那次 tag 运行跳过了 publish，所以 2026-10-21 建的配置从未被验证，2026-11-19 首次真正跑 OIDC 时 registry 直接回 404。
   > - **2026-09-03 之后创建的配置默认只允许 `npm stage publish`**：要直接 `npm publish`，必须在表单里显式勾选 **Allow npm publish**；管理 dist-tag 还要单独勾 **Allow npm dist-tag**（npm CLI 需 ≥ 11.21.0 / 12.2.0）。
   > - registry 对"没有匹配的 trusted publisher"也回 **404 而不是 403**，所以 404 基本等于 OIDC 身份被拒，不是网络或包名问题；对照组是日志里有没有 `Signed provenance statement`。

5. 补上 `0.1.0` 的 tag，并推上去把 CI 门禁跑通：

   ```bash
   git tag -a v0.1.0 -m "0.1.0：首次公开发布"
   git push origin v0.1.0
   ```

   这一次 workflow 会**跳过发布**（`0.1.0` 已经在 registry 上，步骤日志里会打一行
   notice），所以它证明的是**门禁**：`pnpm install --frozen-lockfile`、显式的
   `Gate — tsc, bundle, tests` 步骤（`pnpm check`，524 例）、以及 tag 与 `package.json`
   互校，都在干净的 runner 上过了。它**不验证 OIDC 本身**——`npm publish` 被跳过了，
   OIDC 的第一次真实交换发生在 `0.1.1`（见 §2）。

   > 门禁是独立的一步、不是靠 `prepublishOnly`：npm 的 `prepublishOnly` 挂在
   > `npm publish` 上，而跳过发布时那一步根本不执行。真发布时同一套门禁会再跑一遍，
   > 多花约 40 秒，换"跳过的 run 仍然有意义"。
6. **收尾（必做）**：删掉 GitHub 的 `NPM_TOKEN` secret、在 npm 撤销那个 token、删除
   `publish-bootstrap.yml`。之后每个版本都只靠 tag 触发。

> 为什么不在 `0.1.0` 就直接推 tag：npm 只能给**已存在**的包铸造 trusted publisher，
> 第一次必须借一次 token（或本地发一次）；而 tag 一旦推上去就会跑 workflow，所以顺序
> 只能是"先把 `0.1.0` 发出去，再配 OIDC，最后用那个 tag 校验门禁"。workflow 里的
> `Skip a version the registry already has` 步骤就是为这个顺序准备的，同时也让重复推
> 同一个 tag 变成一次无害的跳过。

> 后备方案（不推荐）：本地 `npm publish --otp <6 位码>` 发 0.1.0，之后同样去配
> trusted publisher。缺点：这一版没有 provenance，且违背"不在本地发布"的约定。

## 2. 每一次发版

```bash
pnpm check                                  # 与 CI 同一套门禁：tsc --noEmit + 构建 + 全部测试
# ……功能提交……
# 只改 package.json 的 version
git commit -am "chore: release X.Y.Z"
git tag -a "vX.Y.Z" -m "X.Y.Z：一句话说明"
git push origin main
git push origin "vX.Y.Z"                    # 这一步才触发 publish.yml
```

规则：

- **tag 名必须等于 `package.json` 的版本**（去掉 `v`）。工作流会互校，不一致直接失败。
- 版本号按语义化版本判断：用户可见的新能力 → minor；修 bug → patch；破坏兼容 → major。
  `0.x` 阶段破坏性变更仍按 minor 走，但要在 release 说明里写清楚。
- **已推送的 tag 不要移动**。唯一的例外是那次发布**根本没成功**（版本从未上线），此时
  修好树之后把 tag 移到新提交上，并在 release 说明里说明；一旦上线就绝不动。
- 需要预发布（`next`）时用 **Actions → publish → Run workflow**，把 `dist_tag` 选成
  `next`；`latest` 不受影响。
- **发布前先确认 trusted publisher 配置还在、没过期**：要么最近 2 天内有过一次成功发布，
  要么去 npmjs.com → 包 → Settings → Trusted publishing 看一眼；过期只能删除重建（见 §1
  第 4 步的注）。
- **第一次真正走 OIDC 的版本是 `0.1.1`**（`0.1.0` 是本地/引导发出去的，tag 那次又跳过
  了发布）。发完 `0.1.1` 必须确认 `npm view dsh-video-forge@0.1.1 dist.attestations`
  非空——那是 trusted publishing 生效的唯一硬证据；空的话先查 npm 侧 trusted publisher
  的仓库 / workflow 文件名 / environment 三处拼写，再发下一版。
- **推完 tag 要建 GitHub Release**（`gh release create vX.Y.Z --title "vX.Y.Z — 一句话"
  --notes-file …`），标题格式与 `v0.1.0` / `v0.3.0` / `v0.4.0` 保持一致。这一步不是归档
  洁癖：`gh release list` 的 Latest、市场与仓库首页的入口、以及用户判断「该不该升级」
  都看它。2026-11-26 发 `0.4.0` 时就漏了，npm 的 `latest` 已经翻到 0.4.0，仓库的 Latest
  还指着 0.3.0；`0.2.0` / `0.2.1` 更是从一开始就没有 release。**判断发版是否完成，以
  npm `dist-tags` 与 GitHub Release 两处都翻到新版本为准**，CI 绿灯不算。

  note 固定四段，照 `v0.3.0` / `v0.4.0` 写：

  1. 开头一句：这个版本改变了什么，属于修故障还是新增能力。
  2. `## 这个版本有什么`：只写用户能观察到的变化，一条一个结论加上为什么；内部重构、
     测试与文档改动不进这里。
  3. `## 升级提示`：有没有破坏性变更、要不要重启宿主 / 换外部程序、旧行为是否不变，
     末尾附升级命令。
  4. provenance：`sigstore logIndex` 链接 + 这次成功的 Actions run 链接；tag 移动过要
     写明原因（见上面那条例外）。

## 3. 发布后核对

CI 绿灯 **不等于** 包已可用：npm 后端对这包有 **1.5–11 分钟**不等的异步处理延迟，
期间 packument、版本端点与 tarball 三个入口会互相不一致。

```bash
# 1) 等 dist-tags 翻到新版本（而不是只看 CI 日志）
npm view dsh-video-forge dist-tags --json

# 2) 版本端点存在、integrity 与 CI 日志里的 sha512 一致
npm view dsh-video-forge@X.Y.Z dist.integrity dist.attestations --json

# 3) 把发出去的 tarball 拉下来，核对文件清单（0.1.0 是 17 个文件：lib/ 四个、assets/skills/ 五个、
#    locale/ 两个、icon.svg、cordis.patch.yml、README 两份、LICENSE、package.json）
npm pack dsh-video-forge@X.Y.Z --pack-destination /tmp \
  && tar -tzf /tmp/dsh-video-forge-X.Y.Z.tgz | sort
```

`dist.attestations` 缺失说明这一版不是 OIDC 发的（回看 §1 是否收了尾）。

## 4. 在隔离实例里验一次"从 npm 安装"

**绝不使用正在运行的实例**（`http://127.0.0.1:3080/`，`DSH_HOME=~/.dsh`）——那是真实
工作环境，装插件、改设置、跑付费生成都会污染它。完整配方见 `DESIGN.md` §13，要点：

```bash
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_SHELL -u DSH_WEB_URL \
  DSH_HOME=/tmp/dsh-video-studio-verify/home dsh web --port 34781 --no-open
dsh plugin --profile web add dsh-video-forge@X.Y.Z      # 同一个 DSH_HOME
```

然后确认：插件出现在插件列表里、`dsh.bundle` 的 patch 被应用、客户端 bundle 被装载
（启动载荷或 combo 包里能查到 `dsh-video-forge/client.js`）、真浏览器里右侧栏"视频"
面板与卡片播放正常。收尾用 `lsof`/`ps` 复核 34781 已释放。

## 5. 市场收录（发版之后）

`dsh-market` 跟随 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的列表，所以收录只需要向那个仓库提**一个文件**的 PR：
`data/plugins/tkliuxing__dsh-video-forge.yml`（草稿在本仓库 `docs/awesome-entry.yml`）。

提交前提：仓库存在满 1 天、`package.json` 声明了 `dsh.bundle`（已满足）、仓库加了
`dsh-plugin` topic、描述与代码一致（列表维护者会核对数量与命令名）。README 的两个
README 文件是脚本生成的，不要手改。
