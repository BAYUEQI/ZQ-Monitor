# 服务器监控脚本

<p align="center">
  <img src="/src/screenshot-dashboard.png" alt="仪表盘首页" width="90%" />
  <br/>
  <em>仪表盘首页</em>
</p>

<p align="center">
  <img src="/src/screenshot-trends.png" alt="趋势图页面" width="90%" />
  <br/>
  <em>趋势图页面</em>
</p>


## 使用方法


### Cloudflare Worker+D1+KV 纯控制台部署详细流程（适合新手，无需命令行）

### 1. 登录 Cloudflare 控制台
- 打开 https://dash.cloudflare.com/ 并登录你的账号。

### 2. 创建 KV 空间
- 左侧菜单选择“Workers & Pages” → “KV” → “创建命名空间”。
- 名称填写：`monitorkv`，点击“创建”。
- 新增两个键值对：
  - `user`：你的登录用户名（如 admin）
  - `password`：你的登录密码（如 123456）
- 这两个值将用于前端登录，保护监控数据安全。

### 3. 创建 D1 数据库
- 左侧菜单选择“Workers & Pages” → “D1” → “创建数据库”。
- 名称填写：`monitordb`，点击“创建”。
- 进入刚创建的数据库，点击“控制台”，依次执行下方 SQL 建表：

```sql
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  cpu REAL,
  memory REAL,
  disk REAL,
  load REAL,
  net_rx REAL,
  net_tx REAL,
  web_time REAL,
  time INTEGER
);

CREATE TABLE IF NOT EXISTS latest_status (
  ip TEXT PRIMARY KEY,
  name TEXT,
  lastSeen INTEGER,
  status TEXT,
  responseTime INTEGER,
  metrics TEXT,
  services TEXT
);
```

### 4. 创建 Worker 服务
- 左侧菜单选择“Workers & Pages” → “Workers” → “创建 Worker”。
- 名称自定义，如 `monitor-worker`。
- 进入 Worker 编辑页面，将 `worker.js` 文件内容全部粘贴到编辑器中，可按照参数配置(#参数配置)修改必要参数

### 5. 绑定 KV 和 D1 到 Worker
- 在 Worker 编辑页面，点击左侧“设置” → “绑定” → “KV 命名空间”，选择刚才创建的 `monitorkv`，变量名填写 `monitorkv`。
- 同理，点击“D1 数据库”，选择 `monitordb`，变量名填写 `monitordb`。
- 保存绑定。

### 6. 部署 Worker
- 在 Worker 编辑页面点击“保存并部署”。
- 记下分配给你的 Worker 的访问地址（如 https://your-worker.your-account.workers.dev）。

### 7. 配置采集端
- fork本项目
- [参考参数配置](#参数配置)，编辑 `monitor.sh`，其中 `WORKER_URL`,`AUTH_USER`,`AUTH_PASS`一定要修改，其它按需求修改
- 在服务器中运行
```bash
curl -o monitor.sh https://raw.githubusercontent.com/你的用户名/你的仓库名/master/monitor.sh
```
- 在服务器中安装[必装依赖](#必装依赖)，根据自己需要选择安装[可选依赖](#可选依赖)
- 赋予脚本执行权限并运行：
```bash
chmod +x monitor.sh
./monitor.sh
```

### 8. 查看监控面板
- 访问你的 Worker 地址即可看到前端页面和监控数据。
> ⚠️ **如遇注册/上传失败，请检查 Worker 绑定、数据库表结构、KV 空间是否正确。**
> **如需重置注册，删除服务器上的 `/tmp/monitor_token.txt` 并重跑脚本。**
> **如需杀死进程，可执行`ps aux | grep monitor.sh | grep -v grep | awk '{print $2}' | xargs -r kill -9`**

## 参数配置

### monitior.sh
```bash
TRAFFIC_TOTAL_BYTES=1073741824000   # 总流量
INTERVAL_MINUTES=5                  # 上传间隔分钟
SERVER_NAME="默认"                  # 服务器名称
WORKER_URL=""                       # worker地址
AUTH_USER=""                        # 监控面板用户名
AUTH_PASS=""                        # 监控面板密码
```
### worker.js
```bash
const WARNING_THRESHOLD = 5         # 警告阈值：3分钟
const OFFLINE_THRESHOLD = 10        # 离线阈值：10分钟
```
## 必装依赖

Debian/Ubuntu:
```bash
sudo apt update && sudo apt install -y curl jq busybox procps coreutils iproute2
```
CentOS/RHEL:
```bash
sudo yum install -y curl jq busybox procps-ng coreutils iproute
```
Alpine:
```bash
sudo apk add --no-cache curl jq busybox procps coreutils iproute2
```

## 可选依赖

| 依赖包         | 安装命令（Debian/Ubuntu）         | 采集指标           |
|----------------|-----------------------------------|--------------------|
| iptables       | sudo apt install -y iptables      | 防火墙状态         |
| lastb          | sudo apt install -y util-linux    | 登录失败次数       |
| sysstat        | sudo apt install -y sysstat       | 磁盘I/O、CPU各核、队列 |
| lm-sensors     | sudo apt install -y lm-sensors    | 系统温度           |
| smartmontools  | sudo apt install -y smartmontools | 磁盘SMART          |
| mysql-client   | sudo apt install -y mysql-client  | MySQL连接数         |
| redis          | sudo apt install -y redis         | Redis连接数         |
| lsof           | sudo apt install -y lsof          | 端口监听           |
| net-tools      | sudo apt install -y net-tools     | 端口监听           |

> 其它系统请将apt替换为yum或apk。
> 基础依赖必须安装，可选依赖按需安装。脚本会自动检测依赖，缺失时只跳过该项并提示。

## API 调用说明（开发者/自动化调用）

所有 API 均需 Basic Auth 认证，用户名和密码为你在 KV 设置的 user 和 password。

### 示例：获取服务器列表

```bash
curl -u 用户名:密码 https://your-worker.your-account.workers.dev/api/servers
```
或
```bash
curl -H "Authorization: Basic $(echo -n '用户名:密码' | base64)" https://your-worker.your-account.workers.dev/api/servers
```

### 常用 API 列表
- `GET /api/servers`   获取服务器列表和状态
- `GET /api/history?ip=xxx`   获取某台服务器的历史监控数据
- `POST /api/register`   注册新服务器（需传 JSON）
- `POST /api/heartbeat`  上传心跳和监控数据（需传 JSON）
- `POST /api/upload`     上传监控数据（需传 JSON）
- `GET /api/status`      检查服务状态

> 所有 API 均需在请求头加 Basic Auth，否则返回 401。
---



## 请我喝杯奶茶

如果本项目对你有帮助，欢迎请我喝杯奶茶 ☕️~

<p align="center">
  <img src="https://blog.520jacky.ip-ddns.com/img/8.jpg" alt="请我喝杯奶茶" width="220" />
</p>

感谢你的支持！

