# 课堂远程喊话系统

第一版包含：

- 教师网页登录，所有教师共用一个访问码。
- 首次登录填写教师姓名，浏览器保存长期登录令牌。
- 默认 14 个班级，支持单选、多选和全选。
- 公开喊话和私自喊话。
- 常用喊话模板。
- 教室端 Windows 置顶弹窗。
- 学生点击“收到”后回传确认。
- 一个对勾表示服务器已保存，两个对勾表示学生已确认。
- 教室在线状态、消息历史和断线补发。
- 使用 Upstash Redis 保存动态数据。

## 目录结构

```text
public/              教师网页和教室端浏览器模拟器
src/                 Render 后端
config/              14 个班级和常用喊话配置
desktop/             Windows 教室端
test/                自动化集成测试
render.yaml          Render 部署配置
```

## 本地运行

要求 Node.js 20 或更高版本。

```powershell
npm install
npm start
```

打开：

- 教师端：`http://localhost:3000/teacher`
- 教室端模拟器：`http://localhost:3000/simulator`
- 健康检查：`http://localhost:3000/health`

本地默认值：

```text
教师公共访问码：2468
教室设备密码：dev-agent-secret-change-me
```

本地没有配置 Upstash 时会使用内存存储。服务重启后，动态消息会丢失，只适合开发和联调。

## 运行测试

```powershell
npm test
```

测试会验证公共密码登录、公开发送、教师端共享可见、私自喊话隔离、WebSocket 推送和“收到”确认。

## 数据配置

班级配置位于：

```text
config/classes.json
```

目前包含 14 个班级。教室编号必须与 Windows 客户端的 `classId` 一致。

常用喊话位于：

```text
config/common-phrases.json
```

当前包含：

```json
[
  "请课代表来办公室",
  "请班长来办公室"
]
```

直接向数组增加字符串即可增加常用喊话。

## Render 部署

仓库中的 `render.yaml` 已配置：

- Node Web Service
- Singapore 区域
- 免费套餐
- `/health` 健康检查
- 直接提供教师网页，不需要 GitHub Pages

在 Render 创建服务后，需要配置以下环境变量：

```text
TEACHER_PASSWORD=你的公共访问码
AUTH_SECRET=随机长字符串
AGENT_SECRETS_JSON={"class-01":"班级一设备密码","class-02":"班级二设备密码"}
UPSTASH_REDIS_REST_URL=你的UpstashREST地址
UPSTASH_REDIS_REST_TOKEN=你的UpstashREST令牌
```

`AGENT_SECRETS_JSON` 建议为 14 个班分别设置不同的随机密码。Windows 客户端只保存自己班级的密码。

`render.yaml` 会为 `AUTH_SECRET` 自动生成值。如果在 Render 手动创建 Web Service，则需要自己填写。

部署成功后，教师直接访问 Render 提供的域名，例如：

```text
https://your-service.onrender.com
```

教师网页由 Render 后端直接提供，GitHub 只用于保存源代码。

## Hugging Face 保活

Render 免费实例可能在 15 分钟无请求后休眠。项目提供：

```text
scripts/huggingface_keepalive.py
```

在 Hugging Face 的定时任务或 Job 中设置环境变量：

```text
RENDER_HEALTH_URL=https://你的Render域名/health
```

定时任务建议每 5 分钟运行一次：

```bash
python scripts/huggingface_keepalive.py
```

保活只由 Hugging Face 负责。教室端不再把周期性心跳作为 Render 的保活方案，心跳只用于连接状态和消息处理。

## Windows 教室端

教室端第一次运行时会自动打开配置向导，不再要求提前编辑安装包里的 `config.json`。

配置向导会填写：

```text
Render 服务器地址
教室班级
设备编号
设备密码
是否开机自动启动
```

设备编号会默认使用当前 Windows 电脑名称。保存后配置写入当前用户目录：

```text
%APPDATA%\classroom-callboard-desktop\config.json
```

程序随后进入系统托盘，并在收到消息时显示置顶弹窗。托盘菜单中提供“修改配置”和“重新连接”。

## Windows 打包与安装

下载或构建统一的绿色安装包，不要为 14 个班级分别打包：

```powershell
cd desktop
npm install
npm run build:portable
npm run install:local
```

生成文件：

```text
desktop/dist/ClassroomCallboard-portable.zip
```

安装到当前用户目录：

```text
%LOCALAPPDATA%\ClassroomCallboard
```

同时创建桌面和开始菜单快捷方式。其他教室电脑安装同一份包，每台电脑首次启动时选择自己的班级并填写设备密码即可。

如果确实需要预先批量配置，可以使用 `HANHUA_CONFIG` 环境变量指向配置文件，或者把 `config.json` 放在可执行文件旁。普通部署不需要这样做。

收到消息后，程序会创建置顶弹窗。学生点击“收到”后，确认结果回传；网络中断时，确认先保存在教室电脑本地，恢复连接后自动补发。

## 消息规则

- 默认发送公开消息。
- 公开消息会出现在所有老师的全校共享消息流中。
- 私自喊话不会出现在其他老师的消息流中。
- 私自喊话仍会在目标教室电脑弹窗，学生仍需要点击“收到”。
- 多班级消息会分别记录每个班级的送达和确认状态。
- 一条消息的目标班级全部确认后，整体状态显示两个对勾。

## 生产环境注意事项

- 不要使用默认的 `2468` 和 `dev-agent-secret-change-me`。
- 不要将 Upstash Token、设备密码或 `AUTH_SECRET` 写入 GitHub。
- 班级和设备映射可以公开，设备密码不能公开。
- Windows 程序无法覆盖锁屏界面、UAC 安全界面或未登录桌面。
- 免费服务不适合承诺永久可用。正式部署前应设置 Render 和 Upstash 用量监控。
