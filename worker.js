// Cloudflare Worker - 服务器监控面板
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 除了 / 静态页面，其他 API 都要校验 Basic Auth
    if (path !== '/') {
      const authOk = await basicAuthCheck(request, env);
      if (!authOk) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }
    }

    switch (path) {
      case '/':
        return serveStaticFile('index.html', corsHeaders);
      case '/api/status':
        return handleStatusAPI(request, env, corsHeaders);
      case '/api/register':
        return handleRegister(request, env, corsHeaders);
      case '/api/heartbeat':
        return handleHeartbeat(request, env, corsHeaders);
      case '/api/servers':
        return handleGetServers(request, env, corsHeaders);
      case '/api/metrics':
        return handleMetrics(request, env, corsHeaders);
      case '/api/upload':
        return handleUpload(request, env, corsHeaders);
      case '/api/history':
        return handleHistory(request, env, corsHeaders);
      case '/api/delete_server':
        return handleDeleteServer(request, env, corsHeaders);
      default:
        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
  },
};

async function serveStaticFile(filename, corsHeaders) {
  const files = {
    'index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZQ-Monitor 服务器监控面板</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect x='8' y='16' width='48' height='32' rx='6' fill='%23667eea' stroke='%23764ba2' stroke-width='3'/><rect x='16' y='24' width='32' height='16' rx='3' fill='white' stroke='%23764ba2' stroke-width='2'/><circle cx='20' cy='32' r='2' fill='%234ecdc4'/><circle cx='28' cy='32' r='2' fill='%23f39c12'/><circle cx='36' cy='32' r='2' fill='%23ff6b6b'/><rect x='44' y='30' width='6' height='4' rx='2' fill='%23764ba2'/><path d='M24 40 Q32 28 40 40' stroke='%23667eea' stroke-width='2' fill='none'/></svg>">
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            margin: 0;
        }
        /* 登录弹窗样式 */
        #login-modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.45);
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #login-box {
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 32px rgba(0,0,0,0.18);
            padding: 32px 28px 24px 28px;
            min-width: 320px;
            max-width: 90vw;
            text-align: center;
        }
        #login-box h2 {
            margin-bottom: 18px;
            color: #667eea;
        }
        #login-box input {
            width: 90%;
            padding: 10px 12px;
            margin: 10px 0;
            border: 1px solid #ccc;
            border-radius: 6px;
            font-size: 1rem;
        }
        #login-box button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 10px 24px;
            font-size: 1rem;
            cursor: pointer;
            margin-top: 10px;
        }
        #login-error {
            color: #f44336;
            margin-top: 8px;
            min-height: 22px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }
        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
        }
        .stat-value {
            font-size: 2.5rem;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 10px;
        }
        .stat-card.cpu .stat-value { color: #ff6b6b; }
        .stat-card.memory .stat-value { color: #4ecdc4; }
        .stat-card.disk .stat-value { color: #45b7d1; }
        .stat-card.network .stat-value { color: #96ceb4; }
        .stat-card.traffic .stat-value { color: #f39c12; }
        .servers-list {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
        }
        .server-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px;
            margin-bottom: 10px;
            background: rgba(102, 126, 234, 0.1);
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .server-item:hover {
            background: rgba(102, 126, 234, 0.2);
            transform: translateY(-2px);
        }
        .server-details {
            display: none;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 10px;
            padding: 20px;
            margin-top: 10px;
            border-left: 4px solid #667eea;
        }
        .server-details.show {
            display: block;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .metric-item {
            background: rgba(102, 126, 234, 0.05);
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid rgba(102, 126, 234, 0.1);
            min-height: 90px;
            max-height: 90px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }
        .metric-value {
            font-size: 1.5rem;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
            word-break: break-all;
            overflow-y: auto;
            flex: 1;
        }
        .metric-label {
            font-size: 0.9rem;
            color: #666;
            margin-top: 5px;
            font-weight: 500;
        }
        .progress-bar {
            width: 100%;
            height: 8px;
            background: #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            transition: width 0.3s ease;
        }
        .progress-fill.warning {
            background: linear-gradient(90deg, #FF9800, #FFC107);
        }
        .progress-fill.danger {
            background: linear-gradient(90deg, #f44336, #FF5722);
        }
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 10px;
        }
        .status-online { background: #4CAF50; }
        .status-offline { background: #f44336; }
        .status-warning { background: #ff9800; }
        .refresh-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 1rem;
            margin-bottom: 20px;
        }
        .service-status {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: bold;
            margin: 2px;
        }
        .service-running { background: #4CAF50; color: white; }
        .service-stopped { background: #f44336; color: white; }
        .service-unknown { background: #9e9e9e; color: white; }
        .traffic-info {
            background: rgba(243, 156, 18, 0.1);
            border: 1px solid rgba(243, 156, 18, 0.3);
            border-radius: 8px;
            padding: 10px;
            margin-top: 10px;
        }
        .traffic-info h5 {
            color: #f39c12;
            margin: 0 0 8px 0;
            font-size: 0.9rem;
        }
        .traffic-details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 0.8rem;
        }
        .traffic-item {
            display: flex;
            justify-content: space-between;
        }
        .traffic-remaining {
            color: #27ae60;
            font-weight: bold;
        }
        .traffic-used {
            color: #e74c3c;
        }
        .metrics-group {
            margin-bottom: 30px;
        }
        .metrics-group h4 {
            margin: 10px 0 15px 10px;
            color: #764ba2;
            font-size: 1.2rem;
            font-weight: bold;
        }
        .scrollable-long {
            max-height: 60px;
            overflow-y: auto;
            word-break: break-all;
            text-align: left;
            font-size: 0.95rem;
        }
        .metric-reason {
            color: #888;
            font-size: 0.85rem;
            margin-top: 4px;
            word-break: break-all;
        }
        .trend-card {
            background: #fff;
            border-radius: 15px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.08);
            padding: 20px;
            margin-bottom: 25px;
            margin-top: 10px;
        }
        .trend-title {
            font-size: 1.1rem;
            font-weight: bold;
            color: #333;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <!-- 登录弹窗移到最前面，和主界面并列 -->
    <div id="login-modal" style="display:none;">
        <div id="login-box">
            <h2>登录</h2>
            <input id="login-user" type="text" placeholder="用户名" autocomplete="username" />
            <input id="login-pass" type="password" placeholder="密码" autocomplete="current-password" />
            <div id="login-error"></div>
            <button onclick="doLogin()">登录</button>
        </div>
    </div>
    <div class="container" id="main-container">
        <div class="header">
            <h1>ZQ-Monitor 服务器监控面板</h1>
            <p>实时监控您的服务器状态和性能指标</p>
            <div id="github-link" style="margin: 8px 0 8px 0;">
                <a href="https://github.com/BAYUEQI/ZQ-Monitor" target="_blank" style="color:#fff;text-decoration:underline;font-size:1.05rem;">GitHub 项目地址：https://github.com/BAYUEQI/ZQ-Monitor</a>
            </div>
        </div>
        
        <button class="refresh-btn" onclick="refreshData()">🔄 刷新数据</button>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h3>在线服务器</h3>
                <div class="stat-value" id="online-count">0</div>
                <p>当前在线的服务器数量</p>
            </div>
            <div class="stat-card">
                <h3>总服务器</h3>
                <div class="stat-value" id="total-count">0</div>
                <p>已注册的服务器总数</p>
            </div>
            <div class="stat-card">
                <h3>平均响应时间</h3>
                <div class="stat-value" id="avg-response">0ms</div>
                <p>所有服务器的平均响应时间</p>
            </div>
            <div class="stat-card">
                <h3>平均CPU使用率</h3>
                <div class="stat-value" id="avg-cpu">0%</div>
                <p>所有服务器的平均CPU使用率</p>
            </div>
            <div class="stat-card">
                <h3>平均内存使用率</h3>
                <div class="stat-value" id="avg-memory">0%</div>
                <p>所有服务器的平均内存使用率</p>
            </div>
            <div class="stat-card">
                <h3>平均磁盘使用率</h3>
                <div class="stat-value" id="avg-disk">0%</div>
                <p>所有服务器的平均磁盘使用率</p>
            </div>
            <div class="stat-card traffic">
                <h3>平均流量使用率</h3>
                <div class="stat-value" id="avg-traffic">0%</div>
                <p>所有服务器的平均流量使用率</p>
            </div>
        </div>
        
        <div class="servers-list">
            <h3>服务器列表</h3>
            <div id="servers-container">
                <p style="text-align: center; color: #666; padding: 20px;">
                    暂无服务器数据，请按照下方说明添加服务器
                </p>
            </div>
        </div>
        
        <!-- 趋势图容器 - 移到正确位置 -->
        <div id="trends-container" style="display: none;">
            <h3 style="color: white; margin-bottom: 20px;">📊 服务器性能趋势图</h3>
            <div style="margin-bottom: 20px;">
                <label for="server-selector" style="color: white; margin-right: 10px;">选择服务器:</label>
                <select id="server-selector" style="padding: 8px 12px; border-radius: 5px; border: none; background: white; color: #333; font-size: 14px;" onchange="switchServer(this.value)">
                    <option value="" disabled selected>请选择服务器</option>
                </select>
            </div>
            <div class="trend-card">
                <div class="trend-title">CPU使用率趋势</div>
                <div id="trend-cpu" style="width:100%;height:260px;"></div>
            </div>
            <div class="trend-card">
                <div class="trend-title">内存使用率趋势</div>
                <div id="trend-memory" style="width:100%;height:260px;"></div>
            </div>
            <div class="trend-card">
                <div class="trend-title">磁盘使用率趋势</div>
                <div id="trend-disk" style="width:100%;height:260px;"></div>
            </div>
            <div class="trend-card">
                <div class="trend-title">系统负载趋势</div>
                <div id="trend-load" style="width:100%;height:260px;"></div>
            </div>
            <div class="trend-card">
                <div class="trend-title">网络流量趋势</div>
                <div id="trend-net" style="width:100%;height:260px;"></div>
            </div>
            <div class="trend-card">
                <div class="trend-title">Web响应时间趋势</div>
                <div id="trend-webtime" style="width:100%;height:260px;"></div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>
    <script>
        let workerUrl = window.location.origin;
        let currentServerIP = null;
        let expandedServers = new Set(); // 保存展开的服务器状态
        // 登录相关变量
        let authUser = '';
        let authPass = '';
        let isAuthed = false;

        // fetch 包装，自动加 Basic Auth
        async function authFetch(url, options = {}) {
            if (!isAuthed) throw new Error('未登录');
            options.headers = options.headers || {};
            options.headers['Authorization'] = 'Basic ' + btoa(authUser + ':' + authPass);
            return fetch(url, options);
        }

        // 登录弹窗逻辑
        function showLogin(msg = '') {
            document.getElementById('login-modal').style.display = 'flex';
            document.getElementById('login-error').textContent = msg || '';
            document.getElementById('main-container').style.display = 'none'; // 隐藏主界面
        }
        function hideLogin() {
            document.getElementById('login-modal').style.display = 'none';
            document.getElementById('main-container').style.display = ''; // 显示主界面
        }
        function doLogin() {
            const user = document.getElementById('login-user').value.trim();
            const pass = document.getElementById('login-pass').value;
            if (!user || !pass) {
                document.getElementById('login-error').textContent = '请输入用户名和密码';
                return;
            }
            // 尝试用 Basic Auth 访问一个 API
            fetch(workerUrl + '/api/status', {
                headers: { 'Authorization': 'Basic ' + btoa(user + ':' + pass) }
            }).then(res => {
                if (res.ok) {
                    authUser = user;
                    authPass = pass;
                    isAuthed = true;
                    // 保存到localStorage
                    localStorage.setItem('authUser', user);
                    localStorage.setItem('authPass', pass);
                    hideLogin();
                    refreshData();
                } else {
                    document.getElementById('login-error').textContent = '用户名或密码错误';
                }
            }).catch(() => {
                document.getElementById('login-error').textContent = '网络错误';
            });
        }
        // 回车登录
        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('login-user').addEventListener('keydown', function(e) {
                if (e.key === 'Enter') doLogin();
            });
            document.getElementById('login-pass').addEventListener('keydown', function(e) {
                if (e.key === 'Enter') doLogin();
            });
        });
        // 页面加载先弹登录
        document.addEventListener('DOMContentLoaded', function() {
            // 自动读取localStorage
            const savedUser = localStorage.getItem('authUser');
            const savedPass = localStorage.getItem('authPass');
            if (savedUser && savedPass) {
                // 尝试自动登录
                fetch(workerUrl + '/api/status', {
                    headers: { 'Authorization': 'Basic ' + btoa(savedUser + ':' + savedPass) }
                }).then(res => {
                    if (res.ok) {
                        authUser = savedUser;
                        authPass = savedPass;
                        isAuthed = true;
                        hideLogin();
                        refreshData();
                    } else {
                        showLogin();
                    }
                }).catch(() => {
            showLogin();
                });
            } else {
                showLogin();
            }
        });
        
        async function refreshData() {
            if (!isAuthed) return;
            try {
                const response = await authFetch(workerUrl + '/api/servers');
                const data = await response.json();
                updateDashboard(data);
                
                // 趋势图容器默认显示
                document.getElementById('trends-container').style.display = 'block';
                
                // 注释掉自动刷新趋势图的逻辑，让用户手动选择
                // if (data.servers && data.servers.length > 0 && currentServerIP) {
                //     renderTrends(currentServerIP);
                // }
            } catch (error) {
                if (error && error.message && error.message.includes('401')) {
                    isAuthed = false;
                    showLogin('登录已失效，请重新登录');
                } else {
                console.error('获取数据失败:', error);
                }
            }
        }
        
        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function formatGB(bytes) {
          if (!bytes || isNaN(bytes)) return '0 GB';
          return (parseFloat(bytes) / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        }
        
        // 新增：格式化运行时间（秒转天小时分钟秒）
        function formatUptime(seconds) {
            if (!seconds || isNaN(seconds)) return 'N/A';
            seconds = parseInt(seconds);
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            let str = '';
            if (days > 0) str += days + '天';
            if (hours > 0) str += hours + '小时';
            if (minutes > 0) str += minutes + '分钟';
            if (days === 0 && hours === 0 && minutes === 0) str += secs + '秒';
            return str;
        }
        
        function updateDashboard(data) {
            const { servers, stats } = data;
            
            // 保存当前展开的服务器状态
            const currentExpanded = new Set();
            servers.forEach(server => {
                const detailsId = 'details-' + server.name.replace(/[^a-zA-Z0-9]/g, '-');
                const details = document.getElementById(detailsId);
                if (details && details.classList.contains('show')) {
                    currentExpanded.add(server.name);
                }
            });
            
            document.getElementById('online-count').textContent = stats.online;
            document.getElementById('total-count').textContent = stats.total;
            document.getElementById('avg-response').textContent = stats.avgResponse + 'ms';
            document.getElementById('avg-cpu').textContent = stats.avgCpu + '%';
            document.getElementById('avg-memory').textContent = stats.avgMemory + '%';
            document.getElementById('avg-disk').textContent = stats.avgDisk + '%';
            document.getElementById('avg-traffic').textContent = stats.avgTraffic + '%';
            
            // 新增：显示所有服务器的上传时间
            let latestDiv = document.getElementById('latest-upload-time');
            if (!latestDiv) {
                latestDiv = document.createElement('div');
                latestDiv.id = 'latest-upload-time';
                latestDiv.style = 'text-align:center;color:#fff;font-size:1.1rem;margin-bottom:10px;';
                const header = document.querySelector('.header');
                if (header) header.appendChild(latestDiv);
            }
            if (servers && servers.length > 0) {
                // 按时间降序排列
                const sorted = [...servers].sort((a, b) => b.lastSeen - a.lastSeen);
                latestDiv.innerHTML = sorted.map(s => {
                    const d = new Date(s.lastSeen);
                    return s.name + ' (' + s.ip + ') ' +
                        d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' '
                        + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
                }).join('<br>');
            } else {
                latestDiv.textContent = '暂无上传数据';
            }
            
            // 更新服务器选择器
            updateServerSelector(servers);
            
            const container = document.getElementById('servers-container');
            if (servers.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">暂无服务器数据</p>';
                return;
            }
            
            // 渲染服务器列表
            container.innerHTML = servers.map(server => {
                const metrics = server.metrics || {};
                const traffic = metrics.traffic || {};
                const usedBytes = traffic.used || 0;
                const totalBytes = traffic.total || 0;
                const remainingBytes = traffic.remaining || 0;
                const trafficUsage = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
                return (
                    '<div class="server-item">' +
                        '<div class="server-info">' +
                            '<div class="server-name">' + server.name + '</div>' +
                            '<div class="server-details">' +
                                'IP: ' + server.ip + ' | 最后更新: ' + new Date(server.lastSeen).toLocaleString() +
                                ' | CPU: ' + (metrics.cpu || 0) + '% | 内存: ' + (metrics.memory || 0) + '% | 磁盘: ' + (metrics.disk || 0) + '%' +
                            '</div>' +
                        '</div>' +
                        '<div style="display: flex; align-items: center; gap: 8px;">' +
                            '<div class="status-indicator ' + getStatusClass(server.status) + '"></div>' +
                            '<span style="font-weight: bold; color: ' + getStatusColor(server.status) + ';">' +
                                getStatusText(server.status) +
                            '</span>' +
                            '<button class="delete-server-btn" data-ip="' + server.ip + '" style="margin-left:10px;padding:4px 10px;border-radius:6px;border:none;background:#ff6b6b;color:#fff;cursor:pointer;">删除</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="server-details' + (currentExpanded.has(server.name) ? ' show' : '') + '" id="details-' + server.name.replace(/[^a-zA-Z0-9]/g, '-') + '">' +
                        '<div class="metrics-group"><h4>资源监控</h4><div class="metrics-grid">' +
                            renderMetricItem('CPU使用率', metrics.cpu ?? 'N/A', metrics.cpu_reason) +
                            renderMetricItem('内存使用率', metrics.memory ?? 'N/A', metrics.memory_reason) +
                            renderMetricItem('磁盘使用率', metrics.disk ?? 'N/A', metrics.disk_reason) +
                            renderMetricItem('系统负载', metrics.load ?? 'N/A', metrics.load_reason) +
                            renderMetricItem('运行时间', formatUptime(metrics.uptime), metrics.uptime_reason) +
                            renderMetricItem('进程数', metrics.process_count ?? 'N/A', metrics.process_count_reason) +
                            renderMetricItem('文件描述符', metrics.fd_count ?? 'N/A', metrics.fd_count_reason) +
                            renderMetricItem('交换分区使用率', metrics.swap_used ?? 'N/A', metrics.swap_used_reason) +
                            renderMetricItem('5分钟负载', metrics.load5 ?? 'N/A', metrics.load5_reason) +
                            renderMetricItem('15分钟负载', metrics.load15 ?? 'N/A', metrics.load15_reason) +
                            renderMetricItem('CPU核心数', metrics.cpu_cores ?? 'N/A', metrics.cpu_cores_reason) +
                            renderMetricItem('系统温度', metrics.system_temp ?? 'N/A', metrics.system_temp_reason) +
                        '</div></div>' +
                        '<div class="metrics-group"><h4>网络监控</h4><div class="metrics-grid">' +
                            renderMetricItem('网络连接数', metrics.network?.connections ?? 'N/A', metrics.conn_count_reason) +
                            renderMetricItem(
                              '网络接收(GB)',
                              (metrics.network && metrics.network.rx_bytes !== undefined && !isNaN(parseFloat(metrics.network.rx_bytes)) && parseFloat(metrics.network.rx_bytes) > 0)
                                ? (parseFloat(metrics.network.rx_bytes) / 1024 / 1024 / 1024).toFixed(2)
                                : (metrics.network && metrics.network.rx_bytes !== undefined ? metrics.network.rx_bytes : 'N/A'),
                              metrics.net_rx_bytes_reason
                            ) +
                            renderMetricItem(
                              '网络发送(GB)',
                              (metrics.network && metrics.network.tx_bytes !== undefined && !isNaN(parseFloat(metrics.network.tx_bytes)) && parseFloat(metrics.network.tx_bytes) > 0)
                                ? (parseFloat(metrics.network.tx_bytes) / 1024 / 1024 / 1024).toFixed(2)
                                : (metrics.network && metrics.network.tx_bytes !== undefined ? metrics.network.tx_bytes : 'N/A'),
                              metrics.net_tx_bytes_reason
                            ) +
                            renderMetricItem('丢包率', metrics.ping_loss ?? 'N/A', metrics.ping_loss_reason) +
                            renderMetricItem('带宽峰值', metrics.bandwidth_peak ?? 'N/A', metrics.bandwidth_peak_reason) +
                            renderMetricItem('流量总量', totalBytes ? formatGB(totalBytes) : '未知', metrics.traffic_total_reason) +
                            renderMetricItem('流量已用', formatGB(usedBytes), metrics.traffic_used_reason) +
                            renderMetricItem('流量剩余', remainingBytes ? formatGB(remainingBytes) : '未知', metrics.traffic_remaining_reason) +
                            renderMetricItem('流量使用率', totalBytes > 0 ? trafficUsage + '%' : 'N/A', metrics.traffic_usage_reason) +
                        '</div></div>' +
                        '<div class="metrics-group"><h4>安全与服务</h4><div class="metrics-grid">' +
                            renderMetricItem('登录失败次数', metrics.fail_login ?? 'N/A', metrics.fail_login_reason) +
                            renderMetricItem('僵尸进程数', metrics.zombie_count ?? 'N/A', metrics.zombie_count_reason) +
                            renderMetricItem('防火墙状态', metrics.firewall_status ? '已启用' : '未启用', metrics.firewall_status_reason) +
                            renderMetricItem('数据库连接', metrics.db_conn ?? 'N/A', metrics.db_conn_reason) +
                            renderMetricItem('Web服务状态', metrics.web_status ?? 'N/A', metrics.web_status_reason) +
                            renderMetricItem('Web响应时间', metrics.web_time ?? 'N/A', metrics.web_time_reason) +
                            renderMetricItem('错误日志数', metrics.error_log_count ?? 'N/A', metrics.error_log_count_reason) +
                        '</div></div>' +
                        '<div class="metrics-group"><h4>其它信息</h4><div class="metrics-grid">' +
                            renderMetricItem('CPU各核使用率', metrics.cpu_per_core ?? 'N/A', metrics.cpu_per_core_reason) +
                            renderMemDetail(metrics.mem_detail) +
                            renderMetricItem('磁盘队列深度', metrics.disk_queue ?? 'N/A', metrics.disk_queue_reason) +
                            renderMetricItem('端口监听', metrics.listen_ports ?? 'N/A', metrics.listen_ports_reason) +
                            renderMetricItem('网络带宽详情', metrics.net_bandwidth ?? 'N/A', metrics.net_bandwidth_reason) +
                            renderMetricItem(
                              '磁盘I/O详情',
                              (typeof metrics.disk_io === 'string' && metrics.disk_io.includes(';'))
                                ? metrics.disk_io.split(';').join('<br>')
                                : (typeof metrics.disk_io === 'object' && metrics.disk_io !== null)
                                  ? JSON.stringify(metrics.disk_io)
                                  : (metrics.disk_io ?? 'N/A'),
                              metrics.disk_io_reason
                            ) +
                            renderAllMetrics(metrics) +
                        '</div></div>' +
                        '<div style="margin-top: 15px;">' +
                            '<h5>服务状态</h5>' +
                            '<div>' +
                                (server.services ? Object.entries(server.services).map(([service, status]) => 
                                    '<span class="service-status service-' + status + '">' + service + '</span>'
                                ).join('') : '<span class="service-status service-unknown">无服务数据</span>') +
                            '</div>' +
                        '</div>' +
                    '</div>'
                );
            }).join('');

            // 事件委托：只绑定一次
            if (!container._delegated) {
                container.addEventListener('click', function(e) {
                    const item = e.target.closest('.server-item');
                    if (!item) return;
                    if (e.target.classList.contains('delete-server-btn')) {
                        // 删除按钮
                        e.stopPropagation();
                        const ip = e.target.getAttribute('data-ip');
                        if (!ip) return;
                        if (!confirm('确定要删除该服务器及其所有历史数据吗？此操作不可恢复！')) return;
                        authFetch(workerUrl + '/api/delete_server?ip=' + encodeURIComponent(ip))
                            .then(res => res.json())
                            .then(data => {
                                if (data.success) {
                                    alert('删除成功');
                                    refreshData();
                                } else {
                                    alert('删除失败：' + (data.error || '未知错误'));
                                }
                            })
                            .catch(err => {
                                alert('请求失败：' + err);
                            });
                    } else {
                        // 展开/收起
                        toggleDetails(item);
                    }
                });
                container._delegated = true;
            }
        }
        
        function updateServerSelector(servers) {
            const selector = document.getElementById('server-selector');
            if (!selector) return;

            // 只保留第一个"请选择服务器"选项
            // 只保留第一个"请选择服务器"选项
            while (selector.children.length > 1) {
                selector.removeChild(selector.lastChild);
            }

            // 添加服务器选项
            servers.forEach(server => {
                const option = document.createElement('option');
                option.value = server.ip;
                option.textContent = server.name + ' (' + server.ip + ')';
                selector.appendChild(option);
            });

            // 如果当前选中的服务器已被删除，自动清空趋势图
            if (currentServerIP && !servers.some(s => s.ip === currentServerIP)) {
                selector.value = '';
                currentServerIP = null;
                clearTrends();
            }
        }
        
        function switchServer(ip) {
            if (!ip) {
                // 如果没有选择服务器，清空趋势图
                currentServerIP = null;
                clearTrends();
                return;
            }
            currentServerIP = ip;
            renderTrends(ip);
        }
        
        // toggleDetails 只接收 element 参数
        function toggleDetails(element) {
            const serverName = element.querySelector('.server-name').textContent;
            const detailsId = 'details-' + serverName.replace(/[^a-zA-Z0-9]/g, '-');
            const details = document.getElementById(detailsId);
            if (details) {
                const isExpanded = details.classList.contains('show');
                details.classList.toggle('show');
                // 更新展开状态
                if (details.classList.contains('show')) {
                    expandedServers.add(serverName);
                } else {
                    expandedServers.delete(serverName);
                }
                // 获取服务器IP并更新趋势图选择器，但不自动渲染趋势图
                const serverInfo = element.querySelector('.server-details').textContent;
                const ipMatch = serverInfo.match(/IP: ([^\s|]+)/);
                if (ipMatch) {
                    const serverIP = ipMatch[1];
                    // 只更新选择器，不自动渲染趋势图
                    const selector = document.getElementById('server-selector');
                    if (selector) {
                        selector.value = serverIP;
                        currentServerIP = serverIP;
                        // 注释掉自动渲染趋势图
                        // renderTrends(serverIP);
                    }
                }
            }
        }
        
        function getStatusClass(status) {
            switch (status) {
                case 'online': return 'status-online';
                case 'offline': return 'status-offline';
                case 'warning': return 'status-warning';
                default: return 'status-offline';
            }
        }
        
        function getStatusColor(status) {
            switch (status) {
                case 'online': return '#4CAF50';
                case 'offline': return '#f44336';
                case 'warning': return '#ff9800';
                default: return '#f44336';
            }
        }
        
        function getStatusText(status) {
            switch (status) {
                case 'online': return '在线';
                case 'offline': return '离线';
                case 'warning': return '警告';
                default: return '未知';
            }
        }
        
        function getProgressClass(value) {
            if (value >= 90) return 'danger';
            if (value >= 70) return 'warning';
            return '';
        }

        function renderMetricItem(label, value, reason) {
            let showReason = (value === 'N/A' || value === 0 || value === '0') && reason;
            return '<div class="metric-item">' +
                '<div class="metric-label">' + label + '</div>' +
                '<div class="metric-value">' + value + '</div>' +
                (showReason ? '<div class="metric-reason">' + reason + '</div>' : '') +
            '</div>';
        }

        function renderMemDetail(mem_detail) {
          if (!mem_detail) return '';
          const arr = mem_detail.split(',');
          return [
            renderMetricItem('已用内存(MB)', arr[0] || 'N/A'),
            renderMetricItem('可用内存(MB)', arr[1] || 'N/A'),
            renderMetricItem('缓存(MB)', arr[2] || 'N/A'),
            renderMetricItem('缓冲(MB)', arr[3] || 'N/A')
          ].join('');
        }

        function renderAllMetrics(metrics) {
          let known = [
            'cpu','memory','disk','load','uptime','network','process_count','swap_used','load5','load15','cpu_cores','disk_io','bandwidth_peak','fail_login','zombie_count','firewall_status','web_status','web_time','mem_detail','conn_count','listen_ports','net_bandwidth','error_log_count','db_conn','db_conn_reason','web_status_reason','web_time_reason','error_log_count_reason','system_temp','system_temp_reason','cpu_per_core','cpu_per_core_reason','disk_queue','disk_queue_reason','traffic','traffic_total','traffic_used','traffic_remaining','traffic_total_reason','traffic_used_reason','traffic_remaining_reason','network_connections','fd_count','services','service_status','service_running','service_stopped','service_unknown','ping_loss','bandwidth_peak_reason','bandwidth_peak_unit','bandwidth_peak_time','bandwidth_peak_file','bandwidth_peak_last_file','bandwidth_peak_interval','bandwidth_peak_speed','bandwidth_peak_max','bandwidth_peak_cur','bandwidth_peak_last','bandwidth_peak_cur_bytes','bandwidth_peak_last_time','bandwidth_peak_cur_time','bandwidth_peak_last_speed','bandwidth_peak_cur_speed','bandwidth_peak_max_speed','bandwidth_peak_max_time','bandwidth_peak_max_unit','bandwidth_peak_max_reason','bandwidth_peak_max_file','bandwidth_peak_max_last_file','bandwidth_peak_max_interval','bandwidth_peak_max_cur','bandwidth_peak_max_last','bandwidth_peak_max_cur_bytes','bandwidth_peak_max_last_time','bandwidth_peak_max_cur_time','bandwidth_peak_max_last_speed','bandwidth_peak_max_cur_speed','bandwidth_peak_max_max_speed','bandwidth_peak_max_max_time','bandwidth_peak_max_max_unit','bandwidth_peak_max_max_reason','bandwidth_peak_max_max_file','bandwidth_peak_max_max_last_file','bandwidth_peak_max_max_interval','bandwidth_peak_max_max_cur','bandwidth_peak_max_max_last','bandwidth_peak_max_max_cur_bytes','bandwidth_peak_max_max_last_time','bandwidth_peak_max_max_cur_time','bandwidth_peak_max_max_last_speed','bandwidth_peak_max_max_cur_speed','bandwidth_peak_max_max_max_speed','bandwidth_peak_max_max_max_time','bandwidth_peak_max_max_max_max_unit','bandwidth_peak_max_max_max_max_max_reason','bandwidth_peak_max_max_max_max_max_max_file','bandwidth_peak_max_max_max_max_max_max_last_file','bandwidth_peak_max_max_max_max_max_max_interval','bandwidth_peak_max_max_max_max_max_max_cur','bandwidth_peak_max_max_max_max_max_max_last','bandwidth_peak_max_max_max_max_max_max_cur_bytes','bandwidth_peak_max_max_max_max_max_max_last_time','bandwidth_peak_max_max_max_max_max_max_cur_time','bandwidth_peak_max_max_max_max_max_max_last_speed','bandwidth_peak_max_max_max_max_max_max_cur_speed','bandwidth_peak_max_max_max_max_max_max_speed','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_unit','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_reason','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_file','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_file','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_interval','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_bytes','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_time','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_time','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_speed','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_speed','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_speed','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_time','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_unit','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_reason','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_file','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_file','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_interval','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_bytes','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_time','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_time','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_last_speed','bandwidth_peak_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_max_cur_speed'];
          let html = '';
          for (let k in metrics) {
            if (!known.includes(k)) {
              html += renderMetricItem(k, metrics[k]);
            }
          }
          return html;
        }
        
        function drawLine(domId, title, xData, yData, legend, append) {
          let chart = echarts.getInstanceByDom(document.getElementById(domId));
          if (!chart) chart = echarts.init(document.getElementById(domId));
          let option = chart.getOption();
          if (!append || !option || !option.series) {
            option = {
              backgroundColor: '#fff',
              title: { text: '', show: false },
              tooltip: { trigger: 'axis' },
              legend: legend ? { data: [legend], top: 10 } : undefined,
              grid: { left: 40, right: 20, top: 30, bottom: 40 },
              xAxis: {
                type: 'category',
                data: xData,
                name: '时间',
                nameTextStyle: { color: '#888', fontWeight: 'bold' },
                axisLabel: { color: '#333', fontSize: 12, rotate: 0 },
                axisLine: { lineStyle: { color: '#bbb' } },
                splitLine: { show: false }
              },
              yAxis: {
                type: 'value',
                name: title.replace(/趋势$/, ''),
                nameTextStyle: { color: '#888', fontWeight: 'bold' },
                axisLabel: { color: '#333', fontSize: 12 },
                axisLine: { lineStyle: { color: '#bbb' } },
                splitLine: { show: true, lineStyle: { color: '#eee' } }
              },
              // 新增 dataZoom 配置，支持横向缩放和拖动
              dataZoom: [
                {
                  type: 'slider',
                  show: true,
                  xAxisIndex: 0,
                  start: 0,
                  end: 100,
                  height: 18,
                  bottom: 10
                },
                {
                  type: 'inside',
                  xAxisIndex: 0,
                  start: 0,
                  end: 100
                }
              ],
              series: []
            };
          }
          option.series.push({
            name: legend || title,
            type: 'line',
            data: yData,
            smooth: true,
            showSymbol: false,
            lineStyle: { color: legend === '发送' ? '#f39c12' : '#667eea', width: 2 },
            itemStyle: { color: legend === '发送' ? '#f39c12' : '#667eea' }
          });
          chart.setOption(option, true);
        }

        function clearTrends() {
            // 清空所有趋势图
            drawLine('trend-cpu', 'CPU使用率(%)', [], []);
            drawLine('trend-memory', '内存使用率(%)', [], []);
            drawLine('trend-disk', '磁盘使用率(%)', [], []);
            drawLine('trend-load', '系统负载', [], []);
            drawLine('trend-net', '网络接收(GB)', [], []);
            drawLine('trend-net', '网络发送(GB)', [], [], '发送', true);
            drawLine('trend-webtime', 'Web响应时间(ms)', [], []);
        }

        function renderTrends(ip) {
          if (!isAuthed) return;
          fetchTrends(ip);
        }
        async function fetchTrends(ip) {
          try {
            const res = await authFetch('/api/history?ip=' + ip);
            const history = await res.json();
              // 关键调试输出
              console.log('趋势图历史数据:', history);
              if (!Array.isArray(history) || history.length === 0) {
                console.log('没有历史数据，显示空图表');
                // 没有数据也要画空图
                drawLine('trend-cpu', 'CPU使用率(%)', [], []);
                drawLine('trend-memory', '内存使用率(%)', [], []);
                drawLine('trend-disk', '磁盘使用率(%)', [], []);
                drawLine('trend-load', '系统负载', [], []);
                drawLine('trend-net', '网络接收(GB)', [], []);
                drawLine('trend-net', '网络发送(GB)', [], [], '发送', true);
                drawLine('trend-webtime', 'Web响应时间(ms)', [], []);
                return;
              }
              
              // 修复数据格式问题 - 确保数值类型正确
              const times = history.map(item => {
                const d = new Date(item.time);
                return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' '
                  + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
              });
              const cpuData = history.map(item => parseFloat(item.cpu) || 0);
              const memoryData = history.map(item => parseFloat(item.memory) || 0);
              const diskData = history.map(item => parseFloat(item.disk) || 0);
              const loadData = history.map(item => parseFloat(item.load) || 0);
              const netRxData = history.map(item => {
                const value = parseFloat(item.net_rx) || 0;
                return value > 0 ? (value / 1024 / 1024 / 1024) : 0;
              });
              const netTxData = history.map(item => {
                const value = parseFloat(item.net_tx) || 0;
                return value > 0 ? (value / 1024 / 1024 / 1024) : 0;
              });
              const webTimeData = history.map(item => parseFloat(item.web_time) || 0);
              
              console.log('处理后的数据:', {
                times: times.length,
                cpu: cpuData,
                memory: memoryData,
                disk: diskData,
                load: loadData,
                netRx: netRxData,
                netTx: netTxData,
                webTime: webTimeData
              });
              
              drawLine('trend-cpu', 'CPU使用率(%)', times, cpuData);
              drawLine('trend-memory', '内存使用率(%)', times, memoryData);
              drawLine('trend-disk', '磁盘使用率(%)', times, diskData);
              drawLine('trend-load', '系统负载', times, loadData);
              drawLine('trend-net', '网络接收(GB)', times, netRxData);
              drawLine('trend-net', '网络发送(GB)', times, netTxData, '发送', true);
              drawLine('trend-webtime', 'Web响应时间(ms)', times, webTimeData);
            } catch (err) {
              if (err && err.message && err.message.includes('401')) {
                  isAuthed = false;
                  showLogin('登录已失效，请重新登录');
              } else {
              console.error('趋势图数据加载失败', err);
              }
            }
        }
        
        refreshData();
        setInterval(refreshData, 30000);
    </script>
</body>
</html>`
  };

  const content = files[filename];
  if (!content) {
    return new Response('File not found', { status: 404, headers: corsHeaders });
  }

  return new Response(content, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

async function handleStatusAPI(request, env, corsHeaders) {
  return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// 1. 注册接口只用KV保存注册信息
async function handleRegister(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const data = await request.json();
    const { name, ip, token } = data;
    if (!name || !ip) {
      return new Response(JSON.stringify({ error: '缺少必要参数' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const regInfo = {
      name,
      ip,
      token: token || generateToken(),
      registeredAt: Date.now()
    };
    await env.monitorkv.put(`server:${ip}`, JSON.stringify(regInfo));
    return new Response(JSON.stringify({ 
      success: true, 
      token: regInfo.token,
      message: '服务器注册成功' 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '注册失败' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// 2. 心跳/上传接口：校验token查KV，所有状态写D1
async function handleHeartbeat(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const data = await request.json();
    const { ip, token, responseTime = 0, metrics = {}, services = {}, name } = data;
    if (!ip || !token) {
      return new Response(JSON.stringify({ error: '缺少必要参数' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // 校验token只查KV
    const regRaw = await env.monitorkv.get(`server:${ip}`);
    if (!regRaw) {
      return new Response(JSON.stringify({ error: '服务器未注册' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const regInfo = JSON.parse(regRaw);
    if (regInfo.token !== token) {
      return new Response(JSON.stringify({ error: 'Token无效' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // 写入history表
    const net_rx = metrics.network?.rx_bytes ?? metrics.net_rx_bytes ?? metrics.rx_bytes ?? 0;
    const net_tx = metrics.network?.tx_bytes ?? metrics.net_tx_bytes ?? metrics.tx_bytes ?? 0;
    await env.monitordb.prepare(
      `INSERT INTO history (ip, cpu, memory, disk, load, net_rx, net_tx, web_time, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(ip, metrics.cpu, metrics.memory, metrics.disk, metrics.load, net_rx, net_tx, metrics.web_time, Date.now()).run();
    // 写入/更新latest_status表
    await env.monitordb.prepare(
      `INSERT INTO latest_status (ip, name, lastSeen, status, responseTime, metrics, services) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET name=excluded.name, lastSeen=excluded.lastSeen, status=excluded.status, responseTime=excluded.responseTime, metrics=excluded.metrics, services=excluded.services`
    ).bind(ip, regInfo.name || name || '', Date.now(), 'online', responseTime, JSON.stringify(metrics), JSON.stringify(services)).run();
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '心跳更新失败', detail: error && error.message ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// 状态判断时间配置（单位：分钟）
const WARNING_THRESHOLD = 5;  // 警告阈值：3分钟
const OFFLINE_THRESHOLD = 10; // 离线阈值：10分钟

// 3. 服务器列表接口只查D1
async function handleGetServers(request, env, corsHeaders) {
  try {
    const { results } = await env.monitordb.prepare('SELECT * FROM latest_status').all();
    const servers = [];
    let totalResponseTime = 0;
    let onlineCount = 0;
    let totalCpu = 0;
    let totalMemory = 0;
    let totalDisk = 0;
    let totalTraffic = 0;
    let trafficCount = 0;
    for (const row of results) {
      const metrics = row.metrics ? JSON.parse(row.metrics) : {};
      // 动态判断状态
      let status = 'offline';
      const now = Date.now();
      if (row.lastSeen) {
        const diff = now - row.lastSeen;
        if (diff <= WARNING_THRESHOLD * 60 * 1000) {
          status = 'online';
        } else if (diff <= OFFLINE_THRESHOLD * 60 * 1000) {
          status = 'warning';
        } else {
          status = 'offline';
        }
      }
      const server = {
        name: row.name,
        ip: row.ip,
        lastSeen: row.lastSeen,
        status,
        responseTime: row.responseTime,
        metrics,
        services: row.services ? JSON.parse(row.services) : {}
      };
      // 状态统计
      if (status === 'online') onlineCount++;
      if (row.responseTime > 0) totalResponseTime += row.responseTime;
      if (metrics) {
        totalCpu += metrics.cpu || 0;
        totalMemory += metrics.memory || 0;
        totalDisk += metrics.disk || 0;
        if (metrics.traffic && metrics.traffic.total > 0) {
          const trafficUsage = Math.round((metrics.traffic.used / metrics.traffic.total) * 100);
          totalTraffic += trafficUsage;
          trafficCount++;
        }
      }
      servers.push(server);
    }
    const stats = {
      total: servers.length,
      online: onlineCount,
      offline: servers.length - onlineCount,
      avgResponse: servers.length > 0 ? Math.round(totalResponseTime / servers.length) : 0,
      avgCpu: servers.length > 0 ? Math.round(totalCpu / servers.length) : 0,
      avgMemory: servers.length > 0 ? Math.round(totalMemory / servers.length) : 0,
      avgDisk: servers.length > 0 ? Math.round(totalDisk / servers.length) : 0,
      avgTraffic: trafficCount > 0 ? Math.round(totalTraffic / trafficCount) : 0,
    };
    return new Response(JSON.stringify({ servers, stats }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '获取服务器列表失败' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleMetrics(request, env, corsHeaders) {
  // 处理指标查询API
  return new Response(JSON.stringify({ 
    message: '指标API已启用',
    timestamp: Date.now() 
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleUpload(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const data = await request.json();
    const { ip, token, responseTime = 0, metrics = {}, services = {}, name } = data;
    if (!ip || !token) {
      return new Response(JSON.stringify({ error: '缺少必要参数 ip 或 token' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // 校验token只查KV
    const regRaw = await env.monitorkv.get(`server:${ip}`);
    if (!regRaw) {
      return new Response(JSON.stringify({ error: '服务器未注册，请先注册' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const regInfo = JSON.parse(regRaw);
    if (regInfo.token !== token) {
      return new Response(JSON.stringify({ error: 'Token无效' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // 写入history表
    const net_rx = metrics.network?.rx_bytes ?? metrics.net_rx_bytes ?? metrics.rx_bytes ?? 0;
    const net_tx = metrics.network?.tx_bytes ?? metrics.net_tx_bytes ?? metrics.tx_bytes ?? 0;
    await env.monitordb.prepare(
      `INSERT INTO history (ip, cpu, memory, disk, load, net_rx, net_tx, web_time, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(ip, metrics.cpu, metrics.memory, metrics.disk, metrics.load, net_rx, net_tx, metrics.web_time, Date.now()).run();
    // 写入/更新latest_status表
    await env.monitordb.prepare(
      `INSERT INTO latest_status (ip, name, lastSeen, status, responseTime, metrics, services) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET name=excluded.name, lastSeen=excluded.lastSeen, status=excluded.status, responseTime=excluded.responseTime, metrics=excluded.metrics, services=excluded.services`
    ).bind(ip, regInfo.name || name || '', Date.now(), 'online', responseTime, JSON.stringify(metrics), JSON.stringify(services)).run();
    return new Response(JSON.stringify({ 
      success: true,
      message: '数据上传成功',
      timestamp: Date.now()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: '上传失败', 
      detail: error.message || String(error) 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleHistory(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip');
    if (!ip) {
      return new Response(JSON.stringify({ error: '缺少ip参数' }), { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // 直接用SQL查D1
    const { results } = await env.monitordb.prepare(
      `SELECT cpu, memory, disk, load, net_rx, net_tx, web_time, time FROM history WHERE ip = ? ORDER BY time ASC`
    ).bind(ip).all();

    // 兼容原前端格式
    const history = results.map(row => ({
      cpu: parseFloat(row.cpu) || 0,
      memory: parseFloat(row.memory) || 0,
      disk: parseFloat(row.disk) || 0,
      load: parseFloat(row.load) || 0,
      net_rx: parseFloat(row.net_rx) || 0,
      net_tx: parseFloat(row.net_tx) || 0,
      web_time: parseFloat(row.web_time) || 0,
      time: parseInt(row.time) || Date.now()
    }));

    return new Response(JSON.stringify(history), { 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '获取历史数据失败', detail: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// 删除服务器及其所有数据
async function handleDeleteServer(request, env, corsHeaders) {
  // 只允许 GET 并校验 Basic Auth
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  const url = new URL(request.url);
  const ip = url.searchParams.get('ip');
  if (!ip) {
    return new Response(JSON.stringify({ error: '缺少ip参数' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  try {
    // 删除 latest_status
    await env.monitordb.prepare('DELETE FROM latest_status WHERE ip = ?').bind(ip).run();
    // 删除 history
    await env.monitordb.prepare('DELETE FROM history WHERE ip = ?').bind(ip).run();
    // 删除 KV 注册
    await env.monitorkv.delete(`server:${ip}`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '删除失败', detail: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

function generateToken() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
} 

// Basic Auth 校验函数
async function basicAuthCheck(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) return false;
  try {
    const b64 = auth.slice(6);
    const [user, pass] = atob(b64).split(':');
    const kvUser = await env.monitorkv.get('user');
    const kvPass = await env.monitorkv.get('password');
    return user === kvUser && pass === kvPass;
  } catch {
    return false;
  }
} 