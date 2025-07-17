#!/bin/bash

# ====== 用户自定义配置（请根据实际情况修改） ======
AUTH_USER=""         # 监控面板用户名
AUTH_PASS=""        # 监控面板密码
WORKER_URL=""  # Worker地址
SERVER_NAME="默认"   # 服务器名称
TRAFFIC_TOTAL_BYTES=214748364800  # 总流量（字节）
# 请根据您的VPS流量套餐修改以下值
# 100GB = 107374182400 字节
# 500GB = 536870912000 字节  
# 1TB = 1073741824000 字节
# 2TB = 2199023255552 字节
INTERVAL_MINUTES=5        # 上传间隔分钟

# ====== 自我守护：如果不是在后台就自动重启到后台 ======
LOCK_FILE="/tmp/monitor.lock"
if [ -f "$LOCK_FILE" ]; then
    oldpid=$(cat "$LOCK_FILE")
    if [ -d "/proc/$oldpid" ] && grep -q "monitor.sh" /proc/$oldpid/cmdline 2>/dev/null; then
        echo "已有一个监控脚本在运行（PID: $oldpid），请勿重复启动！"
        exit 1
    fi
fi
echo $$ > "$LOCK_FILE"
trap "rm -f $LOCK_FILE; exit" INT TERM EXIT

if [[ "$1" != "child" ]]; then
  nohup bash "$0" child > /var/log/monitor.log 2>&1 &
  echo "监控脚本已在后台守护运行，日志见 /var/log/monitor.log"
  exit 0
fi


# ====== 带宽峰值统计相关文件 ======
BANDWIDTH_PEAK_FILE="/tmp/bandwidth_peak.txt"
BANDWIDTH_LAST_FILE="/tmp/bandwidth_last.txt"

# ====== 系统类型检测 ======
if command -v apk &>/dev/null; then
    OS_TYPE="alpine"
    PKG_INSTALL="apk add --no-cache"
    SERVICE_CMD="rc-service"
elif command -v apt &>/dev/null; then
    OS_TYPE="debian"
    PKG_INSTALL="apt install -y"
    SERVICE_CMD="systemctl"
elif command -v yum &>/dev/null; then
    OS_TYPE="centos"
    PKG_INSTALL="yum install -y"
    SERVICE_CMD="systemctl"
elif command -v dnf &>/dev/null; then
    OS_TYPE="centos8"
    PKG_INSTALL="dnf install -y"
    SERVICE_CMD="systemctl"
else
    OS_TYPE="unknown"
    PKG_INSTALL="echo 请手动安装依赖"
    SERVICE_CMD="ps"
fi

# ====== 依赖检测与友好提示 ======
check_cmd() {
    local cmd=$1
    local pkg=$2
    if ! command -v $cmd &>/dev/null; then
        echo "[缺少依赖] 未检测到 $cmd，请先安装 $pkg"
        return 1
    fi
    return 0
}

# 检查基础依赖（缺失直接退出）
for dep in "curl" "jq" "awk" "ps" "free" "df" "ss"; do
    if ! command -v $dep &>/dev/null; then
        echo "[致命] 缺少基础依赖: $dep，请先安装后再运行脚本。"
        exit 1
    fi
done

# 可选依赖检测函数
check_optional() {
    local cmd=$1
    local name=$2
    if ! command -v $cmd &>/dev/null; then
        # echo "[提示] 未安装 $cmd，跳过${name}采集。"  # 注释掉即时依赖提示，避免日志重复
        return 1
    fi
    return 0
}

# 收集未安装的可选依赖信息
missing_deps=""

# 检查常用高级依赖（如需相关功能请手动安装）
if ! check_cmd iptables iptables; then missing_deps="$missing_deps iptables"; fi
if ! check_cmd lastb util-linux; then missing_deps="$missing_deps lastb"; fi
if ! check_cmd iostat sysstat; then missing_deps="$missing_deps iostat"; fi
if ! check_cmd mpstat sysstat; then missing_deps="$missing_deps mpstat"; fi
if ! check_cmd sensors lm-sensors; then missing_deps="$missing_deps sensors"; fi
if ! check_cmd smartctl smartmontools; then missing_deps="$missing_deps smartctl"; fi
if ! check_cmd mysql mysql-client; then missing_deps="$missing_deps mysql"; fi
if ! check_cmd redis-cli redis; then missing_deps="$missing_deps redis-cli"; fi
if ! check_cmd lsof lsof; then missing_deps="$missing_deps lsof"; fi
if ! check_cmd netstat net-tools; then missing_deps="$missing_deps netstat"; fi

# ====== 可选依赖与采集指标映射 ======
# 依赖名  安装包名  采集指标
OPTIONAL_DEPS=(
  "iptables:iptables:防火墙状态"
  "lastb:util-linux:登录失败次数"
  "iostat:sysstat:磁盘I/O"
  "mpstat:sysstat:CPU各核"
  "sensors:lm-sensors:系统温度"
  "smartctl:smartmontools:磁盘SMART"
  "mysql:mysql-client:MySQL连接数"
  "redis-cli:redis:Redis连接数"
  "lsof:lsof:端口监听"
  "netstat:net-tools:端口监听"
)
missing_deps_info=()
# 检查所有可选依赖
for depinfo in "${OPTIONAL_DEPS[@]}"; do
  IFS=":" read -r cmd pkg metric <<< "$depinfo"
  if ! command -v $cmd &>/dev/null; then
    missing_deps_info+=("$cmd:$pkg:$metric")
  fi
  # 兼容原有 missing_deps 变量
  if ! command -v $cmd &>/dev/null; then
    missing_deps="$missing_deps $cmd"
  fi
done

# 通用工具函数 - 必须在脚本开头定义
safe_num() {
    local v="$1"
    if [[ -z "$v" || "$v" == "N/A" ]]; then
        echo "0"
    elif [[ "$v" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
        echo "$v"
    else
        echo "0"
    fi
}

get_value() {
    local cmd="$1"
    local default="$2"
    eval "$cmd" 2>/dev/null || echo "$default"
}

# 配置参数
# WORKER_URL="https://vps.vpnjacky.dpdns.org"
# SERVER_NAME="华为云1"
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s ipinfo.io/ip 2>/dev/null || echo "unknown")

if [ -z "$WORKER_URL" ]; then
    echo "使用方法: $0 <worker_url> [server_name]"
    echo "示例: $0 https://my-monitor.your-subdomain.workers.dev '我的服务器'"
    exit 1
fi

# 创建配置文件
TOKEN_FILE="/tmp/monitor_token.txt"

# 获取或生成token
if [ ! -f "$TOKEN_FILE" ]; then
    echo "准备注册"
    REGISTER_RESPONSE=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -X POST "$WORKER_URL/api/register" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"$SERVER_NAME\",\"ip\":\"$SERVER_IP\"}")
    
    TOKEN=$(echo "$REGISTER_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    
    if [ -n "$TOKEN" ]; then
        echo "$TOKEN" > "$TOKEN_FILE"
        echo "注册完成"
        echo "服务器注册成功！Token: $TOKEN"
    else
        echo "注册失败: $REGISTER_RESPONSE"
        exit 1
    fi
else
    TOKEN=$(cat "$TOKEN_FILE")
fi

echo "token=$TOKEN"

# 基础采集函数（无需额外安装）
get_cpu() {
    if command -v top &>/dev/null; then
        # 优先使用top方法，计算更准确
        top -bn1 | grep 'Cpu(s)' | awk '{us=$2; sy=$4; ni=$6; printf "%.0f", us+sy+ni}' | sed 's/,//g'
    elif [ -f /proc/stat ]; then
        # 修复/proc/stat方法：排除I/O等待时间
        cpu1=($(grep '^cpu ' /proc/stat))
        # 只计算user, nice, system, idle, iowait, irq, softirq, steal
        # 排除iowait (第5个字段) 从总计算中
        idle1=${cpu1[4]}
        iowait1=${cpu1[5]}
        total1=0
        for i in {1..10}; do
            if [ $i -ne 5 ]; then  # 跳过iowait
                total1=$((total1 + ${cpu1[$i]}))
            fi
        done
        
        sleep 0.1
        
        cpu2=($(grep '^cpu ' /proc/stat))
        idle2=${cpu2[4]}
        iowait2=${cpu2[5]}
        total2=0
        for i in {1..10}; do
            if [ $i -ne 5 ]; then  # 跳过iowait
                total2=$((total2 + ${cpu2[$i]}))
            fi
        done
        
        # 计算CPU使用率，排除I/O等待
        cpu=$((100 * ( (total2-total1) - (idle2-idle1) ) / (total2-total1) ))
        echo $cpu
    else
        echo "N/A"
    fi
}

get_mem() {
    if command -v free &>/dev/null; then
        free | awk '/Mem/ {printf("%.0f", $3/$2*100)}'
    else
        echo "N/A"
    fi
}

get_mem_detail() {
    if command -v free &>/dev/null; then
        # 采集顺序：已用内存, 可用内存, 缓存, 缓冲
        free -m | awk '/^Mem:/ {printf "%d,%d,%d,%d", $3, $7, $6, $5}'
    else
        echo "N/A"
    fi
}

get_disk() {
    if command -v df &>/dev/null; then
        df / | awk 'NR==2 {print $5}' | tr -d '%'
    else
        echo "N/A"
    fi
}

get_load() {
    if command -v uptime &>/dev/null; then
        uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ','
    else
        echo "N/A"
    fi
}

get_proc() {
    # 使用更准确的命令统计进程数
    if [ -f /proc/stat ]; then
        # 从/proc目录统计进程数，更准确
        ls -1 /proc/ | grep -E '^[0-9]+$' | wc -l
    else
        ps -e --no-headers | wc -l
    fi
}

get_conn() {
    if command -v ss &>/dev/null; then
        # 使用更快的ss命令，只统计TCP和UDP连接
        ss -tun --no-header | wc -l
    elif [ -f /proc/net/tcp ] && [ -f /proc/net/udp ]; then
        # 直接从/proc/net统计，最快
        echo $(( $(wc -l < /proc/net/tcp) + $(wc -l < /proc/net/udp) - 2 ))
    else
        echo "N/A"
    fi
}

# 采集磁盘I/O
if check_optional iostat "磁盘I/O"; then
    disk_io=$(iostat -dx 1 2 | awk 'NR>7 {print $1":"$4"/"$5}' | paste -sd';' -)
else
    disk_io="N/A"
fi

# 采集CPU各核
if check_optional mpstat "CPU各核"; then
    cpu_per_core=$(mpstat -P ALL 1 1 | awk '/^[0-9]/ && $3 ~ /[0-9]+/ {printf "%s:%.1f%%,", $3,100-$12}' | sed 's/,$//')
else
    cpu_per_core="N/A"
fi

# 采集磁盘队列
if check_optional iostat "磁盘队列"; then
    disk_queue=$(iostat -dx 1 2 | awk 'NR>7 {sum+=$9} END{print sum}')
else
    disk_queue="N/A"
fi

# 采集系统温度
if check_optional sensors "系统温度"; then
    system_temp=$(sensors | grep -m1 'temp1' | awk '{print $2}' | tr -d '+' | tr -d '°C')
else
    system_temp="N/A"
fi

# 采集SMART
if check_optional smartctl "磁盘SMART"; then
    smart_info=$(smartctl -a /dev/sda 2>/dev/null | grep -E 'Reallocated_Sector_Ct|Power_On_Hours|Temperature_Celsius')
else
    smart_info="N/A"
fi

# 采集MySQL连接
if check_optional mysql "MySQL连接数"; then
    db_conn=$(mysql -uroot -e "show status like 'Threads_connected';" 2>/dev/null | awk '/Threads_connected/ {print $2}')
else
    db_conn="N/A"
fi

# 采集Redis连接
if check_optional redis-cli "Redis连接数"; then
    redis_conn=$(redis-cli info clients 2>/dev/null | grep connected_clients | awk -F: '{print $2}')
else
    redis_conn="N/A"
fi

# 采集端口监听
if check_optional lsof "端口监听"; then
    listen_ports=$(lsof -i -P -n | grep LISTEN | awk '{print $9}' | paste -sd',' -)
elif check_optional netstat "端口监听"; then
    listen_ports=$(netstat -lntp | awk 'NR>2 {print $4}' | paste -sd',' -)
else
    listen_ports="N/A"
fi

# 采集网络带宽详情
net_bandwidth=$(if [ -f /proc/net/dev ]; then
    cat /proc/net/dev | grep -E 'eth|ens|enp|eno' | awk '{printf "接口:%s 接收:%s 发送:%s;", $1, $2, $10}' | sed 's/;$//'
else
    echo "N/A"
fi)

# 采集错误日志数量
error_log_count=$(if [ -f /var/log/nginx/error.log ]; then
    tail -1000 /var/log/nginx/error.log 2>/dev/null | wc -l
elif [ -f /var/log/apache2/error.log ]; then
    tail -1000 /var/log/apache2/error.log 2>/dev/null | wc -l
else
    echo "0"
fi)

# 采集文件描述符数量
fd_count=$(if [ -f /proc/sys/fs/file-nr ]; then
    awk '{print $1}' /proc/sys/fs/file-nr
else
    echo "N/A"
fi)

# 采集ping丢包率（简单测试）
ping_loss=$(if command -v ping &>/dev/null; then
    ping -c 3 8.8.8.8 2>/dev/null | grep "packet loss" | awk '{print $6}' | tr -d '%' || echo "N/A"
else
    echo "N/A"
fi)

# 采集防火墙
if check_optional iptables "防火墙状态"; then
    firewall_status=$(iptables -L INPUT --line-numbers 2>/dev/null | head -5 | tr '\n' ' ' | sed 's/  */ /g')
else
    firewall_status="N/A"
fi

# 采集登录失败
if check_optional lastb "登录失败次数"; then
    fail_login=$(lastb 2>/dev/null | wc -l)
else
    fail_login="N/A"
fi

# 初始化reason变量
cpu_reason=""
mem_reason=""
disk_reason=""
load_reason=""
proc_reason=""
conn_reason=""
uptime_reason=""
swap_reason=""
cpu_cores_reason=""
load5_reason=""
load15_reason=""


# 新增：采集系统总运行时间（秒）
UPTIME=$(cat /proc/uptime | awk '{print int($1)}')

# ====== 流量计算 ======
# 1. 获取当前月份
CURRENT_MONTH=$(date +%Y-%m)
MONTH_FILE="/tmp/monitor_traffic_month.txt"
USED_FILE="/tmp/monitor_traffic_used.txt"

# 2. 检查是否需要归零
if [ ! -f "$MONTH_FILE" ] || [ "$(cat $MONTH_FILE)" != "$CURRENT_MONTH" ]; then
    echo "$CURRENT_MONTH" > "$MONTH_FILE"
    echo "0" > "$USED_FILE"
fi

# 3. 读取本月已用流量
traffic_used=$(cat "$USED_FILE" 2>/dev/null || echo "0")

# 4. 采集本次流量（如 net_rx_bytes + net_tx_bytes）
current_total=$((net_rx_bytes + net_tx_bytes))

# 5. 计算本次与上次的差值，累加到 traffic_used
LAST_TOTAL_FILE="/tmp/monitor_traffic_last_total.txt"
last_total=$(cat "$LAST_TOTAL_FILE" 2>/dev/null || echo "$current_total")
delta=$((current_total - last_total))
if [ "$delta" -lt 0 ]; then delta=0; fi # 防止重启或溢出导致负数
traffic_used=$((traffic_used + delta))
echo "$traffic_used" > "$USED_FILE"
echo "$current_total" > "$LAST_TOTAL_FILE"

# 计算已用流量和剩余流量
traffic_remaining=$((TRAFFIC_TOTAL_BYTES - traffic_used))

# 确保剩余流量不为负数
if [ "$traffic_remaining" -lt 0 ]; then
    traffic_remaining=0
fi

# 确保所有数值都是数字
traffic_total=$(safe_num "$TRAFFIC_TOTAL_BYTES")
traffic_used=$(safe_num "$traffic_used")
traffic_remaining=$(safe_num "$traffic_remaining")

# ====== 带宽峰值统计 ======
# 自动检测流量最大的非 lo 网卡
main_nic=$(awk -F: 'NR>2 && $1 !~ /lo/ {gsub(/ /, "", $1); print $1}' /proc/net/dev | \
  xargs -I{} sh -c "awk '/^ *{}:/ {print \"{}\", \$2+\$10}' /proc/net/dev" | \
  sort -k2 -nr | head -n1 | awk '{print $1}')

# 采集主网卡流量
net_rx_bytes=$(awk -F: -v nic="$main_nic" 'NR>2 {gsub(/ /, "", $1);} $1 == nic {print $2}' /proc/net/dev)
net_tx_bytes=$(awk -F: -v nic="$main_nic" 'NR>2 {gsub(/ /, "", $1);} $1 == nic {print $10}' /proc/net/dev)
if [ -z "$net_rx_bytes" ]; then net_rx_bytes=0; fi
if [ -z "$net_tx_bytes" ]; then net_tx_bytes=0; fi

# 带宽峰值统计
now_ts=$(date +%s)
cur_total_bytes=$((net_rx_bytes + net_tx_bytes))
peak_mbps=0

BANDWIDTH_LAST_FILE="/tmp/bandwidth_last.txt"
BANDWIDTH_PEAK_FILE="/tmp/bandwidth_peak.txt"

if [ -f "$BANDWIDTH_LAST_FILE" ]; then
    read last_ts last_bytes < "$BANDWIDTH_LAST_FILE"
    interval=$((now_ts - last_ts))
    if [ "$interval" -gt 0 ]; then
        speed_bps=$(( (cur_total_bytes - last_bytes) / interval ))
        speed_mbps=$(awk "BEGIN{printf \"%.2f\", $speed_bps*8/1024/1024}")
        if [ -f "$BANDWIDTH_PEAK_FILE" ]; then
            peak_mbps=$(cat "$BANDWIDTH_PEAK_FILE")
        fi
        awk -v cur=$speed_mbps -v peak=$peak_mbps 'BEGIN{if(cur>peak){print cur}else{print peak}}' > "$BANDWIDTH_PEAK_FILE"
        peak_mbps=$(cat "$BANDWIDTH_PEAK_FILE")
    fi
fi
echo "$now_ts $cur_total_bytes" > "$BANDWIDTH_LAST_FILE"

# 基础磁盘IO（无需额外安装）
# disk_io_read=$(get_value "cat /proc/diskstats | grep '^[[:space:]]*[0-9]' | head -1 | awk '{print \$6}'" "0")
# disk_io_write=$(get_value "cat /proc/diskstats | grep '^[[:space:]]*[0-9]' | head -1 | awk '{print \$10}'" "0")

# 服务状态检查（无需额外安装）
check_service() {
    local service="$1"
    if command -v systemctl &>/dev/null; then
        if systemctl is-active --quiet "$service" 2>/dev/null; then
            echo "running"
            return
        fi
    fi
    if command -v service &>/dev/null; then
        if service "$service" status 2>/dev/null | grep -q running; then
            echo "running"
            return
        fi
    fi
    if command -v rc-service &>/dev/null; then
        if rc-service "$service" status 2>/dev/null | grep -q started; then
            echo "running"
            return
        fi
    fi
    if pgrep -x "$service" >/dev/null 2>&1; then
        echo "running"
        return
    fi
    echo "stopped"
}

# 检查常见服务
# nginx_status=$(check_service "nginx")
# apache_status=$(check_service "apache2")
# mysql_status=$(check_service "mysql")
# redis_status=$(check_service "redis")
# docker_status=$(check_service "docker")

# 确保所有数值都是数字
# cpu_usage=$(safe_num "$cpu_usage")
# mem_usage=$(safe_num "$mem_usage")
# disk_usage=$(safe_num "$disk_usage")
# load_avg=$(safe_num "$load_avg")
# process_count=$(safe_num "$process_count")
# network_connections=$(safe_num "$network_connections")
# swap_used=$(safe_num "$swap_used")
# cpu_cores=$(safe_num "$cpu_cores")
# load5=$(safe_num "$load5")
# load15=$(safe_num "$load15")
# net_rx_bytes=$(safe_num "$net_rx_bytes")
# net_tx_bytes=$(safe_num "$net_tx_bytes")
# disk_io_read=$(safe_num "$disk_io_read")
# disk_io_write=$(safe_num "$disk_io_write")

# ====== 安全与服务指标采集 ======
# 登录失败次数 - 优化为更快的统计方式
# fail_login=$(if [ -f /var/log/auth.log ]; then
#     # 只统计最近的失败登录，而不是全部历史
#     tail -1000 /var/log/auth.log 2>/dev/null | grep -c "Failed password" || echo "0"
# elif [ -f /var/log/secure ]; then
#     tail -1000 /var/log/secure 2>/dev/null | grep -c "Failed password" || echo "0"
# else
#     # 如果日志文件不存在，使用lastb但限制数量
#     lastb 2>/dev/null | head -100 | wc -l
# fi)
# 僵尸进程数 - 优化为更快的统计方式
# zombie_count=$(if [ -f /proc/stat ]; then
#     # 直接从/proc统计僵尸进程，更快
#     grep -c "Z" /proc/*/stat 2>/dev/null | tail -1 | cut -d: -f2 || echo "0"
# else
#     ps -eo state --no-headers | grep -c "^Z" || echo "0"
# fi)
# 防火墙状态 - 优化为更快的检查方式
# firewall_status=$(if command -v iptables &> /dev/null; then 
#     # 只检查INPUT链的前几行，减少输出
#     iptables -L INPUT --line-numbers 2>/dev/null | head -5 | tr '\n' ' ' | sed 's/  */ /g' || echo "N/A"
# else 
#     echo "N/A"
# fi)
# Web服务状态（nginx为例）
# web_status=$(check_service "nginx")
# Web响应时间
# web_time=$(if command -v curl &>/dev/null; then curl -o /dev/null -s -w "%{time_total}" http://127.0.0.1 2>/dev/null | awk '{printf("%.0f", $1*1000)}'; else echo "N/A"; fi)

# 构建JSON数据
json=$(jq -n \
    --arg ip "$SERVER_IP" \
    --arg token "$TOKEN" \
    --argjson cpu "$cpu_usage" \
    --argjson memory "$mem_usage" \
    --arg mem_detail "$mem_detail" \
    --argjson disk "$disk_usage" \
    --argjson load "$load_avg" \
    --argjson uptime "$UPTIME" \
    --argjson network_connections "$network_connections" \
    --argjson process_count "$process_count" \
    --argjson swap_used "$swap_used" \
    --argjson load5 "$load5" \
    --argjson load15 "$load15" \
    --argjson cpu_cores "$cpu_cores" \
    --argjson disk_io_read "$disk_io_read" \
    --argjson disk_io_write "$disk_io_write" \
    --argjson net_rx_bytes "$net_rx_bytes" \
    --argjson net_tx_bytes "$net_tx_bytes" \
    --argjson bandwidth_peak "$peak_mbps" \
    --argjson fail_login "$fail_login" \
    --argjson zombie_count "$zombie_count" \
    --arg firewall_status "$firewall_status" \
    --arg web_status "$web_status" \
    --arg web_time "$web_time" \
    --argjson traffic_total "$traffic_total" \
    --argjson traffic_used "$traffic_used" \
    --argjson traffic_remaining "$traffic_remaining" \
    --arg disk_io "$disk_io" \
    --arg cpu_per_core "$cpu_per_core" \
    --argjson disk_queue "$disk_queue" \
    --arg system_temp "$system_temp" \
    --arg smart_info "$smart_info" \
    --arg db_conn "$db_conn" \
    --arg redis_conn "$redis_conn" \
    --arg listen_ports "$listen_ports" \
    --arg nginx_status "$nginx_status" \
    --arg apache_status "$apache_status" \
    --arg mysql_status "$mysql_status" \
    --arg redis_status "$redis_status" \
    --arg docker_status "$docker_status" \
    --arg net_bandwidth "$net_bandwidth" \
    --arg error_log_count "$error_log_count" \
    --arg fd_count "$fd_count" \
    --arg ping_loss "$ping_loss" \
    '{
        ip: $ip,
        token: $token,
        metrics: {
            cpu: $cpu,
            memory: $memory,
            mem_detail: $mem_detail,
            disk: $disk,
            load: $load,
            uptime: $uptime,
            network: {
                connections: $network_connections,
                rx_bytes: $net_rx_bytes,
                tx_bytes: $net_tx_bytes
            },
            traffic: {
                total: $traffic_total,
                used: $traffic_used,
                remaining: $traffic_remaining
            },
            process_count: $process_count,
            swap_used: $swap_used,
            load5: $load5,
            load15: $load15,
            cpu_cores: $cpu_cores,
            disk_io: $disk_io,
            disk_io_read: $disk_io_read,
            disk_io_write: $disk_io_write,
            cpu_per_core: $cpu_per_core,
            disk_queue: $disk_queue,
            system_temp: $system_temp,
            smart_info: $smart_info,
            bandwidth_peak: $bandwidth_peak,
            fail_login: $fail_login,
            zombie_count: $zombie_count,
            firewall_status: $firewall_status,
            web_status: $web_status,
            web_time: $web_time,
            db_conn: $db_conn,
            redis_conn: $redis_conn,
            listen_ports: $listen_ports,
            net_bandwidth: $net_bandwidth,
            error_log_count: $error_log_count,
            fd_count: $fd_count,
            ping_loss: $ping_loss
        },
        services: {
            nginx: $nginx_status,
            apache: $apache_status,
            mysql: $mysql_status,
            redis: $redis_status,
            docker: $docker_status
        }
    }'
)

# 清空日志，只保留本次内容
> /var/log/monitor.log
# 测量真实响应时间并上传
start_time=$(date +%s%3N)
response=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -w "HTTPSTATUS:%{http_code}" -X POST "$WORKER_URL/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$json")
end_time=$(date +%s%3N)
response_time=$((end_time - start_time))

# 用 jq 给 JSON 加上 responseTime 字段
json_with_time=$(echo "$json" | jq --argjson responseTime "$response_time" '.responseTime = $responseTime')

# 再次上传，带真实responseTime
final_response=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -X POST "$WORKER_URL/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$json_with_time")

echo "发送数据: $json_with_time"
echo "响应: $final_response"

# 检查响应
if echo "$final_response" | grep -q '"success":true'; then
    echo "✅ 心跳更新成功"
else
    echo "❌ 心跳更新失败: $final_response"
fi 

echo "===== 基础监控脚本调试输出 ====="
echo "CPU使用率: $cpu_usage"
echo "内存使用率: $mem_usage"
echo "内存详情: $mem_detail"
echo "磁盘使用率: $disk_usage"
echo "系统负载: $load_avg"
echo "运行时间: $UPTIME 秒"
echo "进程数: $process_count"
echo "网络连接数: $network_connections"
echo "交换分区使用率: $swap_used"
echo "5分钟负载: $load5"
echo "15分钟负载: $load15"
echo "CPU核心数: $cpu_cores"
echo "网络接收: $net_rx_bytes"
echo "网络发送: $net_tx_bytes"
echo "带宽峰值(Mbps): $peak_mbps"
echo "磁盘IO读取: $disk_io_read"
echo "磁盘IO写入: $disk_io_write"
echo "磁盘IO详情: $disk_io"
echo "CPU各核使用率: $cpu_per_core"
echo "磁盘队列深度: $disk_queue"
echo "系统温度: $system_temp"
echo "磁盘SMART: $smart_info"
echo "MySQL连接数: $db_conn"
echo "Redis连接数: $redis_conn"
echo "端口监听: $listen_ports"
echo "网络带宽详情: $net_bandwidth"
echo "错误日志数: $error_log_count"
echo "文件描述符: $fd_count"
echo "Ping丢包率: $ping_loss"
echo "登录失败次数: $fail_login"
echo "僵尸进程数: $zombie_count"
echo "防火墙状态: $firewall_status"
echo "Web服务状态: $web_status"
echo "Web响应时间: $web_time ms"
echo "流量总量: $traffic_total 字节 ($(echo "scale=2; $traffic_total/1024/1024/1024" | bc) GB)"
echo "已用流量: $traffic_used 字节 ($(echo "scale=2; $traffic_used/1024/1024/1024" | bc) GB)"
echo "剩余流量: $traffic_remaining 字节 ($(echo "scale=2; $traffic_remaining/1024/1024/1024" | bc) GB)"
echo "服务状态 - Nginx: $nginx_status, Apache: $apache_status, MySQL: $mysql_status, Redis: $redis_status, Docker: $docker_status"
echo "=========================="

# 输出未安装依赖信息（增强版，带采集指标）
if [ ${#missing_deps_info[@]} -gt 0 ]; then
    echo "===== 未安装的可选依赖 ====="
    echo "以下依赖未安装，相关采集指标已跳过："
    for depinfo in "${missing_deps_info[@]}"; do
        IFS=":" read -r cmd pkg metric <<< "$depinfo"
        case $pkg in
            iptables|util-linux|sysstat|lm-sensors|smartmontools|mysql-client|redis|lsof|net-tools)
                install_cmd="apt install -y $pkg"
                ;;
            *)
                install_cmd="$PKG_INSTALL $pkg"
                ;;
        esac
        echo "  - $cmd ($metric) - 安装: $install_cmd"
    done
    echo "=========================="
fi
while true; do
    TMP_LOG="/tmp/monitor.log.$$"
    {
        # 每次循环都重新采集数据
        cpu_usage=$(get_cpu)
        mem_usage=$(get_mem)
        mem_detail=$(get_mem_detail)
        disk_usage=$(get_disk)
        load_avg=$(get_load)
        process_count=$(get_proc)
        # 网络连接数采集修正
        network_connections=$(get_conn)
        network_connections=$(safe_num "$network_connections")
        UPTIME=$(cat /proc/uptime | awk '{print int($1)}')
        swap_used=$(get_value "free | awk '/Swap/ {print $3/$2*100}'" "0")
        cpu_cores=$(get_value "grep -c ^processor /proc/cpuinfo" "1")
        load5=$(get_value "uptime | awk -F'load average:' '{print \$2}' | awk '{print \$2}' | tr -d ','" "0")
        load15=$(get_value "uptime | awk -F'load average:' '{print \$2}' | awk '{print \$3}' | tr -d ','" "0")
        # 自动检测主网卡（排除lo、docker、veth等虚拟网卡，取流量最大的）
        main_nic=$(awk -F: 'NR>2 && $1 !~ /lo|docker|veth/ {gsub(/ /, "", $1); print $1}' /proc/net/dev | \
          xargs -I{} sh -c "awk '/^ *{}:/ {print \"{}\", \$2+\$10}' /proc/net/dev" | \
          sort -k2 -nr | head -n1 | awk '{print $1}')

# 通用采集主网卡流量（split+去空格，适配所有主流格式）
net_rx_bytes=$(awk -F: -v nic="$main_nic" '
  NR>2 {
    gsub(/ /, "", $1);
    if ($1 == nic) {
      split($2, arr, " ");
      cnt=0;
      for (i in arr) if (arr[i] != "") {cnt++; val[cnt]=arr[i]}
      print val[1];
    }
  }
' /proc/net/dev)

net_tx_bytes=$(awk -F: -v nic="$main_nic" '
  NR>2 {
    gsub(/ /, "", $1);
    if ($1 == nic) {
      split($2, arr, " ");
      cnt=0;
      for (i in arr) if (arr[i] != "") {cnt++; val[cnt]=arr[i]}
      print val[9];
    }
  }
' /proc/net/dev)
        echo "主网卡: $main_nic"
        echo "主网卡接收字节: $net_rx_bytes"
        echo "主网卡发送字节: $net_tx_bytes"
        if [ -z "$net_rx_bytes" ]; then net_rx_bytes=0; fi
        if [ -z "$net_tx_bytes" ]; then net_tx_bytes=0; fi
        if [ "$net_rx_bytes" = "0" ]; then
            net_rx_bytes=$(cat /proc/net/dev | grep -E 'eth|ens|enp|eno' | head -1 | awk '{print $2}')
            net_tx_bytes=$(cat /proc/net/dev | grep -E 'eth|ens|enp|eno' | head -1 | awk '{print $10}')
            if [ -z "$net_rx_bytes" ] || [ -z "$net_tx_bytes" ]; then
                net_rx_bytes=0
                net_tx_bytes=0
            fi
        fi
        disk_io_read=$(get_value "cat /proc/diskstats | grep '^[[:space:]]*[0-9]' | head -1 | awk '{print \\$6}'" "0")
        disk_io_write=$(get_value "cat /proc/diskstats | grep '^[[:space:]]*[0-9]' | head -1 | awk '{print \\$10}'" "0")
        nginx_status=$(check_service "nginx")
        apache_status=$(check_service "apache2")
        mysql_status=$(check_service "mysql")
        redis_status=$(check_service "redis")
        docker_status=$(check_service "docker")
        fail_login=$(if [ -f /var/log/auth.log ]; then tail -1000 /var/log/auth.log 2>/dev/null | grep -c "Failed password" || echo "0"; elif [ -f /var/log/secure ]; then tail -1000 /var/log/secure 2>/dev/null | grep -c "Failed password" || echo "0"; else lastb 2>/dev/null | head -100 | wc -l; fi)
        zombie_count=$(if [ -f /proc/stat ]; then grep -c "Z" /proc/*/stat 2>/dev/null | tail -1 | cut -d: -f2 || echo "0"; else ps -eo state --no-headers | grep -c "^Z" || echo "0"; fi)
        firewall_status=$(if command -v iptables &> /dev/null; then iptables -L INPUT --line-numbers 2>/dev/null | head -5 | tr '\n' ' ' | sed 's/  */ /g' || echo "N/A"; else echo "N/A"; fi)
        web_status=$(check_service "nginx")
        web_time=$(if command -v curl &>/dev/null; then curl -o /dev/null -s -w "%{time_total}" http://127.0.0.1 2>/dev/null | awk '{printf("%.0f", $1*1000)}'; else echo "N/A"; fi)
        # 修复丢包率采集，适配大部分系统
        ping_loss=$(ping -c 3 8.8.8.8 | grep -oE '[0-9]+% packet loss' | head -1 | grep -oE '^[0-9]+')
        ping_loss=$(safe_num "$ping_loss")
        # 保证所有数值都是数字
        cpu_usage=$(safe_num "$cpu_usage")
        mem_usage=$(safe_num "$mem_usage")
        disk_usage=$(safe_num "$disk_usage")
        load_avg=$(safe_num "$load_avg")
        process_count=$(safe_num "$process_count")
        network_connections=$(safe_num "$network_connections")
        swap_used=$(safe_num "$swap_used")
        load5=$(safe_num "$load5")
        load15=$(safe_num "$load15")
        cpu_cores=$(safe_num "$cpu_cores")
        disk_io_read=$(safe_num "$disk_io_read")
        disk_io_write=$(safe_num "$disk_io_write")
        net_rx_bytes=$(safe_num "$net_rx_bytes")
        net_tx_bytes=$(safe_num "$net_tx_bytes")
        peak_mbps=$(safe_num "$peak_mbps")
        fail_login=$(safe_num "$fail_login")
        zombie_count=$(safe_num "$zombie_count")
        disk_queue=$(safe_num "$disk_queue")
        traffic_total=$(safe_num "$traffic_total")
        traffic_used=$(safe_num "$traffic_used")
        traffic_remaining=$(safe_num "$traffic_remaining")
        # 构建JSON数据
        json=$(jq -n \
            --arg ip "$SERVER_IP" \
            --arg token "$TOKEN" \
            --argjson cpu "$cpu_usage" \
            --argjson memory "$mem_usage" \
            --arg mem_detail "$mem_detail" \
            --argjson disk "$disk_usage" \
            --argjson load "$load_avg" \
            --argjson uptime "$UPTIME" \
            --argjson network_connections "$network_connections" \
            --argjson process_count "$process_count" \
            --argjson swap_used "$swap_used" \
            --argjson load5 "$load5" \
            --argjson load15 "$load15" \
            --argjson cpu_cores "$cpu_cores" \
            --argjson disk_io_read "$disk_io_read" \
            --argjson disk_io_write "$disk_io_write" \
            --argjson net_rx_bytes "$net_rx_bytes" \
            --argjson net_tx_bytes "$net_tx_bytes" \
            --argjson bandwidth_peak "$peak_mbps" \
            --argjson fail_login "$fail_login" \
            --argjson zombie_count "$zombie_count" \
            --arg firewall_status "$firewall_status" \
            --arg web_status "$web_status" \
            --arg web_time "$web_time" \
            --argjson traffic_total "$traffic_total" \
            --argjson traffic_used "$traffic_used" \
            --argjson traffic_remaining "$traffic_remaining" \
            --arg disk_io "$disk_io" \
            --arg cpu_per_core "$cpu_per_core" \
            --argjson disk_queue "$disk_queue" \
            --arg system_temp "$system_temp" \
            --arg smart_info "$smart_info" \
            --arg db_conn "$db_conn" \
            --arg redis_conn "$redis_conn" \
            --arg listen_ports "$listen_ports" \
            --arg nginx_status "$nginx_status" \
            --arg apache_status "$apache_status" \
            --arg mysql_status "$mysql_status" \
            --arg redis_status "$redis_status" \
            --arg docker_status "$docker_status" \
            --arg net_bandwidth "$net_bandwidth" \
            --arg error_log_count "$error_log_count" \
            --arg fd_count "$fd_count" \
            --arg ping_loss "$ping_loss" \
            '{
                ip: $ip,
                token: $token,
                metrics: {
                    cpu: $cpu,
                    memory: $memory,
                    mem_detail: $mem_detail,
                    disk: $disk,
                    load: $load,
                    uptime: $uptime,
                    network: {
                        connections: $network_connections,
                        rx_bytes: $net_rx_bytes,
                        tx_bytes: $net_tx_bytes
                    },
                    traffic: {
                        total: $traffic_total,
                        used: $traffic_used,
                        remaining: $traffic_remaining
                    },
                    process_count: $process_count,
                    swap_used: $swap_used,
                    load5: $load5,
                    load15: $load15,
                    cpu_cores: $cpu_cores,
                    disk_io: $disk_io,
                    disk_io_read: $disk_io_read,
                    disk_io_write: $disk_io_write,
                    cpu_per_core: $cpu_per_core,
                    disk_queue: $disk_queue,
                    system_temp: $system_temp,
                    smart_info: $smart_info,
                    bandwidth_peak: $bandwidth_peak,
                    fail_login: $fail_login,
                    zombie_count: $zombie_count,
                    firewall_status: $firewall_status,
                    web_status: $web_status,
                    web_time: $web_time,
                    db_conn: $db_conn,
                    redis_conn: $redis_conn,
                    listen_ports: $listen_ports,
                    net_bandwidth: $net_bandwidth,
                    error_log_count: $error_log_count,
                    fd_count: $fd_count,
                    ping_loss: $ping_loss
                },
                services: {
                    nginx: $nginx_status,
                    apache: $apache_status,
                    mysql: $mysql_status,
                    redis: $redis_status,
                    docker: $docker_status
                }
            }'
        )

        # 测量真实响应时间并上传
        start_time=$(date +%s%3N)
        response=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -w "HTTPSTATUS:%{http_code}" -X POST "$WORKER_URL/api/heartbeat" \
            -H "Content-Type: application/json" \
            -d "$json")
        end_time=$(date +%s%3N)
        response_time=$((end_time - start_time))

        # 用 jq 给 JSON 加上 responseTime 字段
        json_with_time=$(echo "$json" | jq --argjson responseTime "$response_time" '.responseTime = $responseTime')

        # 再次上传，带真实responseTime
        final_response=$(curl -s -u "$AUTH_USER:$AUTH_PASS" -X POST "$WORKER_URL/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$json_with_time")

echo "发送数据: $json_with_time"
echo "响应: $final_response"

# 检查响应
if echo "$final_response" | grep -q '"success":true'; then
    echo "✅ 心跳更新成功"
else
    echo "❌ 心跳更新失败: $final_response"
fi 

echo "===== 基础监控脚本调试输出 ====="
echo "CPU使用率: $cpu_usage"
echo "内存使用率: $mem_usage"
echo "内存详情: $mem_detail"
echo "磁盘使用率: $disk_usage"
echo "系统负载: $load_avg"
echo "运行时间: $UPTIME 秒"
echo "进程数: $process_count"
echo "网络连接数: $network_connections"
echo "交换分区使用率: $swap_used"
echo "5分钟负载: $load5"
echo "15分钟负载: $load15"
echo "CPU核心数: $cpu_cores"
echo "网络接收: $net_rx_bytes"
echo "网络发送: $net_tx_bytes"
echo "带宽峰值(Mbps): $peak_mbps"
echo "磁盘IO读取: $disk_io_read"
echo "磁盘IO写入: $disk_io_write"
echo "磁盘IO详情: $disk_io"
echo "CPU各核使用率: $cpu_per_core"
echo "磁盘队列深度: $disk_queue"
echo "系统温度: $system_temp"
echo "磁盘SMART: $smart_info"
echo "MySQL连接数: $db_conn"
echo "Redis连接数: $redis_conn"
echo "端口监听: $listen_ports"
echo "网络带宽详情: $net_bandwidth"
echo "错误日志数: $error_log_count"
echo "文件描述符: $fd_count"
echo "Ping丢包率: $ping_loss"
echo "登录失败次数: $fail_login"
echo "僵尸进程数: $zombie_count"
echo "防火墙状态: $firewall_status"
echo "Web服务状态: $web_status"
echo "Web响应时间: $web_time ms"
echo "流量总量: $traffic_total 字节 ($(echo "scale=2; $traffic_total/1024/1024/1024" | bc) GB)"
echo "已用流量: $traffic_used 字节 ($(echo "scale=2; $traffic_used/1024/1024/1024" | bc) GB)"
echo "剩余流量: $traffic_remaining 字节 ($(echo "scale=2; $traffic_remaining/1024/1024/1024" | bc) GB)"
echo "服务状态 - Nginx: $nginx_status, Apache: $apache_status, MySQL: $mysql_status, Redis: $redis_status, Docker: $docker_status"
echo "=========================="

# 输出未安装依赖信息（增强版，带采集指标）
if [ ${#missing_deps_info[@]} -gt 0 ]; then
    echo "===== 未安装的可选依赖 ====="
    echo "以下依赖未安装，相关采集指标已跳过："
    for depinfo in "${missing_deps_info[@]}"; do
        IFS=":" read -r cmd pkg metric <<< "$depinfo"
        case $pkg in
            iptables|util-linux|sysstat|lm-sensors|smartmontools|mysql-client|redis|lsof|net-tools)
                install_cmd="apt install -y $pkg"
                ;;
            *)
                install_cmd="$PKG_INSTALL $pkg"
                ;;
        esac
        echo "  - $cmd ($metric) - 安装: $install_cmd"
    done
    echo "=========================="
fi
    echo "\n[等待 $INTERVAL_MINUTES 分钟后再次上传]"
    } > "$TMP_LOG" 2>&1
    mv "$TMP_LOG" /var/log/monitor.log
    sleep $((INTERVAL_MINUTES*60))
done 